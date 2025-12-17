import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import axios from "axios";
import * as crypto from "crypto";
import sharp = require("sharp");

const CONTAINER_NAME = "image-cache";
const BROWSER_CACHE_MAX_AGE = 604800; // 7 days in seconds
const BLOB_CACHE_MAX_AGE_MS = 86400000; // 1 day in milliseconds

let containerClient: ContainerClient | null = null;
let containerInitialized = false;

async function getContainerClient(context?: InvocationContext): Promise<ContainerClient> {
    if (containerClient && containerInitialized) {
        return containerClient;
    }

    const connectionString = process.env.AzureWebJobsStorage;
    if (!connectionString) {
        context?.error("AzureWebJobsStorage connection string not configured");
        throw new Error("AzureWebJobsStorage connection string not configured");
    }

    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const client = blobServiceClient.getContainerClient(CONTAINER_NAME);
        
        // Create container if it doesn't exist (private access - no public blob access)
        await client.createIfNotExists();
        
        // Only set the cached client after successful initialization
        containerClient = client;
        containerInitialized = true;

        return containerClient;
    } catch (err) {
        context?.error(`Failed to create container client: ${err}`);
        throw err;
    }
}

function generateCacheKey(url: string, width?: number, height?: number, format?: string, quality?: number): string {
    const hash = crypto.createHash("sha256");
    hash.update(`${url}|${width || ""}|${height || ""}|${format || "webp"}|${quality || 75}`);
    return hash.digest("hex");
}

async function getCachedImage(cacheKey: string, format: string, context?: InvocationContext): Promise<Buffer | null> {
    try {
        const container = await getContainerClient(context);
        const blobName = `${cacheKey}.${format}`;
        const blobClient = container.getBlobClient(blobName);
        
        // Check if blob exists and get properties to check age
        const properties = await blobClient.getProperties().catch(() => null);
        if (!properties) {
            return null;
        }

        // Check if cached image is older than 1 day
        const lastModified = properties.lastModified;
        if (lastModified && (Date.now() - lastModified.getTime()) > BLOB_CACHE_MAX_AGE_MS) {
            // Cache expired, delete old blob and return null
            await blobClient.deleteIfExists();
            return null;
        }

        const downloadResponse = await blobClient.download();
        const chunks: Buffer[] = [];
        
        for await (const chunk of downloadResponse.readableStreamBody as NodeJS.ReadableStream) {
            chunks.push(Buffer.from(chunk));
        }
        
        return Buffer.concat(chunks);
    } catch (err) {
        context?.error(`Failed to get cached image: ${err}`);
        return null;
    }
}

async function cacheImage(cacheKey: string, format: string, buffer: Buffer, context?: InvocationContext): Promise<void> {
    try {
        const container = await getContainerClient(context);
        const blobName = `${cacheKey}.${format}`;
        const blockBlobClient = container.getBlockBlobClient(blobName);
        
        await blockBlobClient.upload(buffer, buffer.length, {
            blobHTTPHeaders: {
                blobContentType: `image/${format}`,
                blobCacheControl: `public, max-age=${BROWSER_CACHE_MAX_AGE}`
            }
        });
    } catch (err) {
        context?.error(`Failed to cache image: ${err}`);
    }
}

export async function ImageOptimizeProxy(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`Http function processed request for url "${request.url}"`);
    const url = request.query.get("url");
    const w = request.query.get("w");
    const h = request.query.get("h");
    const format = request.query.get("format") || "webp";
    const quality = parseInt(request.query.get("quality") || "75");

    if (!url) {
        return { status: 400, body: "Missing 'url' query parameter." };
    }

    // Limit width and height to maximum 1024 pixels
    const maxDimension = 1024;
    const width = w ? Math.min(parseInt(w), maxDimension) : undefined;
    const height = h ? Math.min(parseInt(h), maxDimension) : undefined;

    // Generate cache key
    const cacheKey = generateCacheKey(url, width, height, format, quality);

    try {
        // Check cache first
        const cachedBuffer = await getCachedImage(cacheKey, format, context);
        if (cachedBuffer) {
            return {
                status: 200,
                headers: {
                    "Content-Type": `image/${format}`,
                    "Cache-Control": `public, max-age=${BROWSER_CACHE_MAX_AGE}`,
                    "X-Cache": "HIT"
                },
                body: cachedBuffer
            };
        }
        const response = await axios.get(url, { responseType: "arraybuffer" });

        const buffer = await sharp(response.data)
            .resize({
                width: width,
                height: height,
                fit: "cover"
            })
            .toFormat(format as keyof sharp.FormatEnum, { quality: quality })
            .toBuffer();

        // Cache the processed image (await to ensure it completes before function exits)
        await cacheImage(cacheKey, format, buffer, context);

        return {
            status: 200,
            headers: {
                "Content-Type": `image/${format}`,
                "Cache-Control": `public, max-age=${BROWSER_CACHE_MAX_AGE}`,
                "X-Cache": "MISS"
            },
            body: buffer
        };
    } catch (err) {
        return { status: 500, body: `Error processing image: ${err}` };
    }
};

app.http('ImageOptimizeProxy', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: ImageOptimizeProxy
});