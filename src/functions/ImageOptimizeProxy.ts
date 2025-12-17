import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import axios from "axios";
import * as crypto from "crypto";
import sharp = require("sharp");

const CONTAINER_NAME = "image-cache";
const BROWSER_CACHE_MAX_AGE = 604800; // 7 days in seconds
const BLOB_CACHE_MAX_AGE_MS = 86400000; // 1 day in milliseconds

let containerClient: ContainerClient | null = null;

async function getContainerClient(): Promise<ContainerClient> {
    if (containerClient) {
        return containerClient;
    }

    const connectionString = process.env.AzureWebJobsStorage;
    if (!connectionString) {
        throw new Error("AzureWebJobsStorage connection string not configured");
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    
    // Create container if it doesn't exist
    await containerClient.createIfNotExists({
        access: "blob" // Allow public read access to blobs
    });

    return containerClient;
}

function generateCacheKey(url: string, width?: number, height?: number, format?: string, quality?: number): string {
    const hash = crypto.createHash("sha256");
    hash.update(`${url}|${width || ""}|${height || ""}|${format || "webp"}|${quality || 75}`);
    return hash.digest("hex");
}

async function getCachedImage(cacheKey: string, format: string): Promise<Buffer | null> {
    try {
        const container = await getContainerClient();
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
    } catch {
        return null;
    }
}

async function cacheImage(cacheKey: string, format: string, buffer: Buffer): Promise<void> {
    try {
        const container = await getContainerClient();
        const blobName = `${cacheKey}.${format}`;
        const blockBlobClient = container.getBlockBlobClient(blobName);
        
        await blockBlobClient.upload(buffer, buffer.length, {
            blobHTTPHeaders: {
                blobContentType: `image/${format}`,
                blobCacheControl: `public, max-age=${BROWSER_CACHE_MAX_AGE}`
            }
        });
    } catch {
        // Silently fail caching - we can still return the processed image
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
        const cachedBuffer = await getCachedImage(cacheKey, format);
        if (cachedBuffer) {
            context.log(`Cache hit for ${cacheKey}`);
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

        context.log(`Cache miss for ${cacheKey}, fetching from source`);
        const response = await axios.get(url, { responseType: "arraybuffer" });

        const buffer = await sharp(response.data)
            .resize({
                width: width,
                height: height,
                fit: "cover"
            })
            .toFormat(format as keyof sharp.FormatEnum, { quality: quality })
            .toBuffer();

        // Cache the processed image (don't await to speed up response)
        cacheImage(cacheKey, format, buffer).catch(err => 
            context.log(`Failed to cache image: ${err}`)
        );

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