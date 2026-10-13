import express from 'express';
import {
    convertPdfToPng,
    autoCropImage,
    cropPdf,
    convertWebToPdf,
    convertWebToImage,
    convertImageToPdf,
    convertImageFormat,
    convertTextToPdf,
    fetchUrlBuffer
} from './converters.js';
import { getUserByConvertApiSecret, getUserByAccessToken } from '../database.js';

export const convertApiRouter = express.Router();

/**
 * Middleware: Authenticate ConvertAPI Request via 30-character Secret or Access Token
 */
export async function authenticateConvertApi(req, res, next) {
    let secret = null;
    const querySecret = req.query.Secret || req.query.secret || req.query.token || req.query.apiKey || req.query.access_token;
    const authHeader = req.headers.authorization;
    const customHeader = req.headers['secret'] || req.headers['convert-secret'] || req.headers['access-token'] || req.headers['x-api-key'];

    if (querySecret) {
        secret = querySecret.toString().trim();
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
        secret = authHeader.substring(7).trim();
    } else if (authHeader && !authHeader.includes(' ')) {
        secret = authHeader.trim();
    } else if (customHeader) {
        secret = customHeader.toString().trim();
    }

    if (!secret) {
        return res.status(401).json({
            Code: 4010,
            Message: 'ConvertAPI Secret is missing. Provide ?Secret=<your_30_character_secret> in query string or Authorization header.',
            InvalidParameters: ['Secret']
        });
    }

    let user = await getUserByConvertApiSecret(secret);
    if (!user) {
        user = await getUserByAccessToken(secret);
    }

    if (!user) {
        return res.status(401).json({
            Code: 4011,
            Message: 'Unauthorized. The provided ConvertAPI Secret is invalid or expired.',
            InvalidParameters: ['Secret']
        });
    }

    req.convertUser = user;
    next();
}

/**
 * Helper: Extract file buffer, URL, and parameters from ConvertAPI payload
 */
async function extractConvertParameters(req) {
    const params = {};
    let fileBuffer = null;
    let fileName = 'document';
    let targetUrl = null;
    let htmlContent = null;
    let textContent = null;

    if (req.body && Array.isArray(req.body.Parameters)) {
        for (const item of req.body.Parameters) {
            if (!item) continue;
            const name = (item.Name || '').toString().toLowerCase();
            const val = item.Value !== undefined ? item.Value : (item.FileValue || item);

            if (name === 'file') {
                if (item.FileValue && item.FileValue.Data) {
                    const cleanBase64 = item.FileValue.Data.replace(/^data:[a-zA-Z0-9\/+]+;base64,/, '').trim();
                    fileBuffer = Buffer.from(cleanBase64, 'base64');
                    fileName = item.FileValue.Name || fileName;
                } else if (item.FileValue && item.FileValue.Url) {
                    targetUrl = item.FileValue.Url;
                } else if (typeof item.Value === 'string') {
                    if (/^https?:\/\//i.test(item.Value.trim())) {
                        targetUrl = item.Value.trim();
                    } else {
                        const cleanBase64 = item.Value.replace(/^data:[a-zA-Z0-9\/+]+;base64,/, '').trim();
                        fileBuffer = Buffer.from(cleanBase64, 'base64');
                    }
                }
            } else if (name === 'url' || name === 'weburl' || name === 'site' || name === 'link') {
                targetUrl = typeof val === 'string' ? val.trim() : (val.Url || val.Data);
            } else if (name === 'html' || name === 'body') {
                htmlContent = typeof val === 'string' ? val : JSON.stringify(val);
            } else if (name === 'text' || name === 'string' || name === 'txt') {
                textContent = typeof val === 'string' ? val : JSON.stringify(val);
            } else {
                params[name] = val;
            }
        }
    } else if (req.body) {
        const rawData = req.body.file || req.body.data || req.body.FileData || req.body.fileBase64 || req.body.image || req.body.pdf;
        if (rawData && typeof rawData === 'string') {
            if (/^https?:\/\//i.test(rawData.trim())) {
                targetUrl = rawData.trim();
            } else {
                const cleanBase64 = rawData.replace(/^data:[a-zA-Z0-9\/+]+;base64,/, '').trim();
                fileBuffer = Buffer.from(cleanBase64, 'base64');
            }
            fileName = req.body.fileName || req.body.name || fileName;
        }

        if (req.body.url || req.body.Url || req.body.link || req.body.site) {
            targetUrl = (req.body.url || req.body.Url || req.body.link || req.body.site).toString().trim();
        }
        if (req.body.html || req.body.Html) {
            htmlContent = (req.body.html || req.body.Html).toString();
        }
        if (req.body.text || req.body.Text) {
            textContent = (req.body.text || req.body.Text).toString();
        }
        Object.assign(params, req.body);
    }

    // If a direct download URL was provided and we don't have a buffer yet (and it's not a pure web page screenshot request)
    if (!fileBuffer && targetUrl && (targetUrl.match(/\.(pdf|png|jpe?g|webp|gif|bmp|txt|csv)(\?.*)?$/i) || params.downloadfirst)) {
        try {
            const fetched = await fetchUrlBuffer(targetUrl);
            fileBuffer = fetched.buffer;
            if (fileName === 'document') {
                const urlPath = new URL(targetUrl).pathname;
                fileName = urlPath.split('/').pop() || 'remote_file';
            }
        } catch (e) {
            console.warn("[ConvertAPI] Could not auto-download URL as file buffer, keeping as targetUrl:", e.message);
        }
    }

    return { fileBuffer, fileName, targetUrl, htmlContent, textContent, params };
}

// --------------------------------------------------------------------------
// Response Builder (ConvertAPI Specification)
// --------------------------------------------------------------------------
function sendConvertSuccess(res, files = []) {
    return res.json({
        ConversionCost: 1,
        Files: files.map(f => ({
            FileName: f.name,
            FileExt: f.ext,
            FileSize: f.buffer.length,
            FileData: f.buffer.toString('base64'),
            Url: `data:${f.mime || 'application/octet-stream'};base64,${f.buffer.toString('base64')}`
        }))
    });
}

// --------------------------------------------------------------------------
// Conversion Handlers
// --------------------------------------------------------------------------

// 1. PDF to Crop (/convert/pdf/to/crop)
async function handlePdfToCrop(req, res) {
    try {
        const { fileBuffer, fileName, targetUrl, params } = await extractConvertParameters(req);
        let srcBuffer = fileBuffer;
        if (!srcBuffer && targetUrl) {
            const fetched = await fetchUrlBuffer(targetUrl);
            srcBuffer = fetched.buffer;
        }

        if (!srcBuffer) {
            return res.status(400).json({ Code: 4000, Message: "Parameter 'File' or 'Url' is required." });
        }

        const cropResult = await cropPdf(srcBuffer, { cropMode: params.cropmode || 'auto', scale: 2.5 });
        const baseName = fileName.replace(/\.[^/.]+$/, "");

        return sendConvertSuccess(res, [{
            name: `${baseName}_cropped.pdf`,
            ext: 'pdf',
            buffer: cropResult.pdfBuffer,
            mime: 'application/pdf'
        }]);
    } catch (err) {
        console.error("[ConvertAPI PDF Crop Error]:", err);
        return res.status(500).json({ Code: 5000, Message: `PDF Crop conversion failed: ${err.message}` });
    }
}

// 2. PDF to PNG/JPG/WebP (/convert/pdf/to/png, /convert/pdf/to/jpg, /convert/pdf/to/webp)
async function handlePdfToImage(req, res, targetFormat = 'png') {
    try {
        const { fileBuffer, fileName, targetUrl, params } = await extractConvertParameters(req);
        let srcBuffer = fileBuffer;
        if (!srcBuffer && targetUrl) {
            const fetched = await fetchUrlBuffer(targetUrl);
            srcBuffer = fetched.buffer;
        }

        if (!srcBuffer) {
            return res.status(400).json({ Code: 4000, Message: "Parameter 'File' or 'Url' is required." });
        }

        const resolution = params.imageresolution || params.dpi || 300;
        const imgBuffer = await convertPdfToPng(srcBuffer, {
            resolution: parseInt(resolution),
            crop: params.crop !== false,
            format: targetFormat,
            quality: parseInt(params.quality || 90)
        });

        const baseName = fileName.replace(/\.[^/.]+$/, "");
        const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

        return sendConvertSuccess(res, [{
            name: `${baseName}.${targetFormat}`,
            ext: targetFormat,
            buffer: imgBuffer,
            mime: mimeMap[targetFormat] || 'image/png'
        }]);
    } catch (err) {
        console.error("[ConvertAPI PDF to Image Error]:", err);
        return res.status(500).json({ Code: 5000, Message: `PDF to Image conversion failed: ${err.message}` });
    }
}

// 3. Web URL / HTML to PDF (/convert/web/to/pdf, /convert/url/to/pdf, /convert/html/to/pdf)
async function handleWebOrHtmlToPdf(req, res) {
    try {
        const { targetUrl, htmlContent, fileBuffer, fileName, params } = await extractConvertParameters(req);
        const source = targetUrl || htmlContent || (fileBuffer ? fileBuffer.toString('utf8') : null);

        if (!source) {
            return res.status(400).json({ Code: 4000, Message: "Parameter 'Url', 'Html', or 'File' is required for Web/HTML to PDF." });
        }

        const pdfBuffer = await convertWebToPdf(source, {
            viewportWidth: params.viewportwidth || params.width || 1280,
            viewportHeight: params.viewportheight || params.height || 800,
            pageFormat: params.pageformat || params.format || 'A4',
            printBackground: params.printbackground !== false,
            landscape: params.landscape === true || params.landscape === 'true',
            marginTop: params.margintop || '10mm',
            marginBottom: params.marginbottom || '10mm',
            marginLeft: params.marginleft || '10mm',
            marginRight: params.marginright || '10mm'
        });

        const baseName = fileName !== 'document' ? fileName.replace(/\.[^/.]+$/, "") : 'webpage';

        return sendConvertSuccess(res, [{
            name: `${baseName}.pdf`,
            ext: 'pdf',
            buffer: pdfBuffer,
            mime: 'application/pdf'
        }]);
    } catch (err) {
        console.error("[ConvertAPI Web to PDF Error]:", err);
        return res.status(500).json({ Code: 5000, Message: `Web to PDF conversion failed: ${err.message}` });
    }
}

// 4. Web URL / HTML to PNG/JPG/WebP (/convert/web/to/png, /convert/url/to/png, /convert/web/to/jpg, /convert/html/to/png)
async function handleWebOrHtmlToImage(req, res, targetFormat = 'png') {
    try {
        const { targetUrl, htmlContent, fileBuffer, fileName, params } = await extractConvertParameters(req);
        const source = targetUrl || htmlContent || (fileBuffer ? fileBuffer.toString('utf8') : null);

        if (!source) {
            return res.status(400).json({ Code: 4000, Message: "Parameter 'Url', 'Html', or 'File' is required for Web to Image." });
        }

        const imgBuffer = await convertWebToImage(source, {
            viewportWidth: params.viewportwidth || params.width || 1280,
            viewportHeight: params.viewportheight || params.height || 800,
            scale: params.scale || 2,
            format: targetFormat,
            fullPage: params.fullpage !== false && params.fullpage !== 'false',
            delay: params.delay || 500,
            crop: params.crop === true || params.crop === 'true',
            quality: parseInt(params.quality || 90)
        });

        const baseName = fileName !== 'document' ? fileName.replace(/\.[^/.]+$/, "") : 'webpage';
        const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

        return sendConvertSuccess(res, [{
            name: `${baseName}.${targetFormat}`,
            ext: targetFormat,
            buffer: imgBuffer,
            mime: mimeMap[targetFormat] || 'image/png'
        }]);
    } catch (err) {
        console.error("[ConvertAPI Web to Image Error]:", err);
        return res.status(500).json({ Code: 5000, Message: `Web to Image conversion failed: ${err.message}` });
    }
}

// 5. Image to PDF (/convert/image/to/pdf, /convert/png/to/pdf, /convert/jpg/to/pdf)
async function handleImageToPdf(req, res) {
    try {
        const { fileBuffer, targetUrl, fileName } = await extractConvertParameters(req);
        let srcBuffer = fileBuffer;
        if (!srcBuffer && targetUrl) {
            const fetched = await fetchUrlBuffer(targetUrl);
            srcBuffer = fetched.buffer;
        }

        if (!srcBuffer) {
            return res.status(400).json({ Code: 4000, Message: "Parameter 'File' or 'Url' is required." });
        }

        const pdfBuffer = await convertImageToPdf(srcBuffer);
        const baseName = fileName.replace(/\.[^/.]+$/, "");

        return sendConvertSuccess(res, [{
            name: `${baseName}.pdf`,
            ext: 'pdf',
            buffer: pdfBuffer,
            mime: 'application/pdf'
        }]);
    } catch (err) {
        console.error("[ConvertAPI Image to PDF Error]:", err);
        return res.status(500).json({ Code: 5000, Message: `Image to PDF conversion failed: ${err.message}` });
    }
}

// 6. Image Format & Crop Conversions (/convert/image/to/crop, /convert/png/to/jpg, /convert/jpg/to/png, /convert/image/to/webp)
async function handleImageFormatConversion(req, res, targetFormat = 'png') {
    try {
        const { fileBuffer, targetUrl, fileName, params } = await extractConvertParameters(req);
        let srcBuffer = fileBuffer;
        if (!srcBuffer && targetUrl) {
            const fetched = await fetchUrlBuffer(targetUrl);
            srcBuffer = fetched.buffer;
        }

        if (!srcBuffer) {
            return res.status(400).json({ Code: 4000, Message: "Parameter 'File' or 'Url' is required." });
        }

        let outBuffer = srcBuffer;
        if (targetFormat === 'crop') {
            outBuffer = await autoCropImage(srcBuffer, { threshold: params.threshold || 10 });
            targetFormat = 'png';
        } else {
            outBuffer = await convertImageFormat(srcBuffer, targetFormat, {
                width: params.width || params.imagewidth,
                height: params.height || params.imageheight,
                quality: params.quality
            });
            if (params.crop === true || params.crop === 'true') {
                outBuffer = await autoCropImage(outBuffer);
            }
        }

        const baseName = fileName.replace(/\.[^/.]+$/, "");
        const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

        return sendConvertSuccess(res, [{
            name: `${baseName}.${targetFormat}`,
            ext: targetFormat,
            buffer: outBuffer,
            mime: mimeMap[targetFormat] || 'image/png'
        }]);
    } catch (err) {
        console.error("[ConvertAPI Image Format Conversion Error]:", err);
        return res.status(500).json({ Code: 5000, Message: `Image conversion failed: ${err.message}` });
    }
}

// 7. Text to PDF (/convert/txt/to/pdf, /convert/text/to/pdf)
async function handleTextToPdf(req, res) {
    try {
        const { textContent, fileBuffer, fileName, params } = await extractConvertParameters(req);
        const text = textContent || (fileBuffer ? fileBuffer.toString('utf8') : null);

        if (!text) {
            return res.status(400).json({ Code: 4000, Message: "Parameter 'Text' or 'File' is required." });
        }

        const pdfBuffer = await convertTextToPdf(text, params);
        const baseName = fileName !== 'document' ? fileName.replace(/\.[^/.]+$/, "") : 'document';

        return sendConvertSuccess(res, [{
            name: `${baseName}.pdf`,
            ext: 'pdf',
            buffer: pdfBuffer,
            mime: 'application/pdf'
        }]);
    } catch (err) {
        console.error("[ConvertAPI Text to PDF Error]:", err);
        return res.status(500).json({ Code: 5000, Message: `Text to PDF conversion failed: ${err.message}` });
    }
}

// --------------------------------------------------------------------------
// Universal Converter Router (/convert/:from/to/:to)
// --------------------------------------------------------------------------
async function handleUniversalConvert(req, res) {
    const from = (req.params.from || '').toLowerCase();
    const to = (req.params.to || '').toLowerCase();

    // 1. PDF sources
    if (from === 'pdf' && to === 'crop') return handlePdfToCrop(req, res);
    if (from === 'pdf' && (to === 'png' || to === 'jpg' || to === 'jpeg' || to === 'webp')) return handlePdfToImage(req, res, to === 'jpeg' ? 'jpg' : to);

    // 2. Web / URL sources
    if ((from === 'web' || from === 'url' || from === 'site') && to === 'pdf') return handleWebOrHtmlToPdf(req, res);
    if ((from === 'web' || from === 'url' || from === 'site') && (to === 'png' || to === 'jpg' || to === 'jpeg' || to === 'webp')) return handleWebOrHtmlToImage(req, res, to === 'jpeg' ? 'jpg' : to);

    // 3. HTML sources
    if (from === 'html' && to === 'pdf') return handleWebOrHtmlToPdf(req, res);
    if (from === 'html' && (to === 'png' || to === 'jpg' || to === 'jpeg' || to === 'webp')) return handleWebOrHtmlToImage(req, res, to === 'jpeg' ? 'jpg' : to);

    // 4. Image sources
    if ((from === 'image' || from === 'png' || from === 'jpg' || from === 'jpeg') && to === 'crop') return handleImageFormatConversion(req, res, 'crop');
    if ((from === 'image' || from === 'png' || from === 'jpg' || from === 'jpeg' || from === 'webp') && to === 'pdf') return handleImageToPdf(req, res);
    if ((from === 'image' || from === 'png' || from === 'jpg' || from === 'jpeg' || from === 'webp') && (to === 'png' || to === 'jpg' || to === 'jpeg' || to === 'webp')) {
        return handleImageFormatConversion(req, res, to === 'jpeg' ? 'jpg' : to);
    }

    // 5. Text sources
    if ((from === 'txt' || from === 'text') && to === 'pdf') return handleTextToPdf(req, res);

    return res.status(400).json({
        Code: 4004,
        Message: `Conversion from '${from}' to '${to}' is not supported yet. Supported combinations: web/to/pdf, web/to/png, web/to/jpg, url/to/pdf, url/to/png, html/to/pdf, html/to/png, pdf/to/crop, pdf/to/png, pdf/to/jpg, image/to/pdf, image/to/crop, png/to/jpg, jpg/to/png, txt/to/pdf.`,
        InvalidParameters: ['from', 'to']
    });
}

// --------------------------------------------------------------------------
// Endpoints Registration
// --------------------------------------------------------------------------

// User & Token Status
convertApiRouter.get('/user', authenticateConvertApi, (req, res) => {
    res.json({
        UserId: req.convertUser.id,
        Email: req.convertUser.email,
        Name: req.convertUser.name,
        Secret: req.convertUser.convert_api_secret,
        SecondsLeft: 9999999,
        Active: true
    });
});

// PDF
convertApiRouter.post('/pdf/to/crop', authenticateConvertApi, handlePdfToCrop);
convertApiRouter.post('/pdf/to/png', authenticateConvertApi, (req, res) => handlePdfToImage(req, res, 'png'));
convertApiRouter.post('/pdf/to/jpg', authenticateConvertApi, (req, res) => handlePdfToImage(req, res, 'jpg'));
convertApiRouter.post('/pdf/to/jpeg', authenticateConvertApi, (req, res) => handlePdfToImage(req, res, 'jpg'));
convertApiRouter.post('/pdf/to/webp', authenticateConvertApi, (req, res) => handlePdfToImage(req, res, 'webp'));

// Web URL
convertApiRouter.post('/web/to/pdf', authenticateConvertApi, handleWebOrHtmlToPdf);
convertApiRouter.post('/url/to/pdf', authenticateConvertApi, handleWebOrHtmlToPdf);
convertApiRouter.post('/web/to/png', authenticateConvertApi, (req, res) => handleWebOrHtmlToImage(req, res, 'png'));
convertApiRouter.post('/url/to/png', authenticateConvertApi, (req, res) => handleWebOrHtmlToImage(req, res, 'png'));
convertApiRouter.post('/web/to/jpg', authenticateConvertApi, (req, res) => handleWebOrHtmlToImage(req, res, 'jpg'));
convertApiRouter.post('/url/to/jpg', authenticateConvertApi, (req, res) => handleWebOrHtmlToImage(req, res, 'jpg'));
convertApiRouter.post('/web/to/webp', authenticateConvertApi, (req, res) => handleWebOrHtmlToImage(req, res, 'webp'));
convertApiRouter.post('/url/to/webp', authenticateConvertApi, (req, res) => handleWebOrHtmlToImage(req, res, 'webp'));

// HTML
convertApiRouter.post('/html/to/pdf', authenticateConvertApi, handleWebOrHtmlToPdf);
convertApiRouter.post('/html/to/png', authenticateConvertApi, (req, res) => handleWebOrHtmlToImage(req, res, 'png'));
convertApiRouter.post('/html/to/jpg', authenticateConvertApi, (req, res) => handleWebOrHtmlToImage(req, res, 'jpg'));

// Image
convertApiRouter.post('/image/to/crop', authenticateConvertApi, (req, res) => handleImageFormatConversion(req, res, 'crop'));
convertApiRouter.post('/image/to/pdf', authenticateConvertApi, handleImageToPdf);
convertApiRouter.post('/png/to/pdf', authenticateConvertApi, handleImageToPdf);
convertApiRouter.post('/jpg/to/pdf', authenticateConvertApi, handleImageToPdf);
convertApiRouter.post('/png/to/jpg', authenticateConvertApi, (req, res) => handleImageFormatConversion(req, res, 'jpg'));
convertApiRouter.post('/jpg/to/png', authenticateConvertApi, (req, res) => handleImageFormatConversion(req, res, 'png'));
convertApiRouter.post('/image/to/webp', authenticateConvertApi, (req, res) => handleImageFormatConversion(req, res, 'webp'));

// Text
convertApiRouter.post('/txt/to/pdf', authenticateConvertApi, handleTextToPdf);
convertApiRouter.post('/text/to/pdf', authenticateConvertApi, handleTextToPdf);

// Universal
convertApiRouter.post('/:from/to/:to', authenticateConvertApi, handleUniversalConvert);

export default convertApiRouter;
