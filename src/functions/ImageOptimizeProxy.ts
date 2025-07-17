import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import axios from "axios";
import sharp = require("sharp");

export async function ImageOptimizeProxy(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`Http function processed request for url "${request.url}"`);
    const url = request.query.get("url");
    const w = request.query.get("w");
    const h = request.query.get("h");
    const format = request.query.get("format") || "webp";
    const quality = request.query.get("quality") || 75;

    if (!url) {
        return { status: 400, body: "Missing 'url' query parameter." };
    }

    try {
        const response = await axios.get(url, { responseType: "arraybuffer" });

        const buffer = await sharp(response.data)
            .resize({
                width: w ? parseInt(w) : undefined,
                height: h ? parseInt(h) : undefined,
                fit: "cover"
            })
            .toFormat(format as keyof sharp.FormatEnum, { quality: parseInt(quality.toString()) })
            .toBuffer();

        return {
            status: 200,
            headers: {
                "Content-Type": `image/${format}`,
                "Cache-Control": "public, max-age=604800" // 7 days
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