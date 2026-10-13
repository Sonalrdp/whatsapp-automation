import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

function findChromeInCache(baseDir) {
    if (!baseDir || !fs.existsSync(baseDir)) return null;
    try {
        const items = fs.readdirSync(baseDir, { recursive: true });
        for (const item of items) {
            const fullPath = path.join(baseDir, item.toString());
            const lower = fullPath.toLowerCase();
            if (lower.endsWith('/chrome') || lower.endsWith('/chromium') || lower.endsWith('\\chrome.exe')) {
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isFile() || stat.isSymbolicLink()) {
                        return fullPath;
                    }
                } catch (e) {}
            }
        }
    } catch (e) {}
    return null;
}

// Find system Chrome/Edge or downloaded Puppeteer Chrome
function getBrowserPath() {
    const candidatePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env.CHROME_PATH,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        findChromeInCache(path.join(process.cwd(), 'chrome')),
        findChromeInCache(path.join(process.cwd(), '.cache', 'puppeteer')),
        findChromeInCache(path.join(os.homedir(), '.cache', 'puppeteer')),
        findChromeInCache('/opt/render/.cache/puppeteer'),
        findChromeInCache('/opt/render/project/src/chrome'),
        findChromeInCache('/root/.cache/puppeteer')
    ].filter(Boolean);

    for (const p of candidatePaths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

let sharedBrowser = null;

export async function getBrowserInstance() {
    if (sharedBrowser && sharedBrowser.connected) {
        return sharedBrowser;
    }
    let executablePath = getBrowserPath();
    if (!executablePath) {
        console.log("[ConvertAPI] No system Chrome/Edge found. Installing Chrome via @puppeteer/browsers...");
        try {
            const output = execSync('npx @puppeteer/browsers install chrome@stable', { encoding: 'utf8' });
            console.log("[ConvertAPI] Chrome auto-install output:", output);
            const lines = output.trim().split('\n');
            const lastLine = lines[lines.length - 1].trim();
            const spaceIdx = lastLine.indexOf(' ');
            const installedPath = spaceIdx !== -1 ? lastLine.substring(spaceIdx + 1).trim() : lastLine;
            if (installedPath && fs.existsSync(installedPath)) {
                executablePath = installedPath;
            } else {
                executablePath = getBrowserPath();
            }
        } catch (installErr) {
            console.warn("[ConvertAPI] Chrome auto-install note:", installErr.message);
            executablePath = getBrowserPath();
        }
    }
    if (!executablePath) {
        throw new Error("No compatible Chrome or Edge browser executable found for rendering.");
    }
    sharedBrowser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--hide-scrollbars'
        ]
    });
    return sharedBrowser;
}

/**
 * Fetch a remote file buffer from a URL (e.g. online PDF, image, document)
 */
export async function fetchUrlBuffer(url, timeoutMs = 25000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Bypass-Tunnel-Reminder': 'true'
            }
        });
        if (!res.ok) {
            throw new Error(`Failed to fetch file from URL (${res.status} ${res.statusText})`);
        }
        const arrayBuf = await res.arrayBuffer();
        const contentType = res.headers.get('content-type') || '';
        return {
            buffer: Buffer.from(arrayBuf),
            contentType
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Auto crop whitespace from an image buffer using sharp
 */
export async function autoCropImage(imageBuffer, options = {}) {
    try {
        const image = sharp(imageBuffer);
        const trimmed = await image.trim({
            threshold: options.threshold || 10
        }).png({ quality: 100 }).toBuffer();
        return trimmed;
    } catch (err) {
        console.warn("[ConvertAPI] Auto-crop note:", err.message);
        return imageBuffer;
    }
}

/**
 * Convert PDF buffer to high-res PNG/JPG/WebP image
 */
export async function convertPdfToPng(pdfBuffer, options = {}) {
    const browser = await getBrowserInstance();
    const page = await browser.newPage();
    try {
        const base64Pdf = pdfBuffer.toString('base64');
        const scale = options.scale || (options.resolution ? Math.min(4, Math.max(1, parseInt(options.resolution) / 72)) : 2.5);

        let pdfjsCode = '';
        try {
            const pdfjsPath = path.resolve('node_modules/pdfjs-dist/build/pdf.min.js');
            if (fs.existsSync(pdfjsPath)) {
                pdfjsCode = fs.readFileSync(pdfjsPath, 'utf8');
            }
        } catch (e) {}

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                ${pdfjsCode ? `<script>${pdfjsCode}</script>` : `<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>`}
                <style>
                    body, html { margin: 0; padding: 0; background: #ffffff; }
                    #container { display: inline-block; }
                    canvas { display: block; }
                </style>
            </head>
            <body>
                <div id="container"></div>
                <script>
                    (async function() {
                        try {
                            const rawData = atob('${base64Pdf}');
                            const uint8Array = new Uint8Array(rawData.length);
                            for (let i = 0; i < rawData.length; i++) {
                                uint8Array[i] = rawData.charCodeAt(i);
                            }

                            const loadingTask = (window.pdfjsLib || pdfjsLib).getDocument({ data: uint8Array });
                            const pdf = await loadingTask.promise;
                            const page = await pdf.getPage(1);
                            const scale = ${scale};
                            const viewport = page.getViewport({ scale: scale });

                            const canvas = document.createElement('canvas');
                            canvas.id = 'pdfCanvas';
                            canvas.height = viewport.height;
                            canvas.width = viewport.width;
                            document.getElementById('container').appendChild(canvas);

                            const context = canvas.getContext('2d');
                            context.fillStyle = '#ffffff';
                            context.fillRect(0, 0, canvas.width, canvas.height);

                            await page.render({ canvasContext: context, viewport: viewport }).promise;
                            window.renderComplete = true;
                        } catch (err) {
                            window.renderError = err.toString();
                        }
                    })();
                </script>
            </body>
            </html>
        `;

        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('window.renderComplete === true || !!window.renderError', { timeout: 25000 });

        const error = await page.evaluate(() => window.renderError);
        if (error) {
            throw new Error(`PDF Render Error: ${error}`);
        }

        const canvasElement = await page.$('#pdfCanvas');
        if (!canvasElement) {
            throw new Error("Could not locate rendered PDF canvas.");
        }

        const imgType = (options.format || 'png').toLowerCase();
        let imageBuffer = await canvasElement.screenshot({
            type: imgType === 'jpg' || imgType === 'jpeg' ? 'jpeg' : 'png',
            omitBackground: false
        });

        if (options.crop !== false) {
            imageBuffer = await autoCropImage(imageBuffer, { threshold: options.cropThreshold || 10 });
        }

        if (imgType === 'webp') {
            imageBuffer = await sharp(imageBuffer).webp({ quality: options.quality || 90 }).toBuffer();
        } else if (imgType === 'jpg' || imgType === 'jpeg') {
            imageBuffer = await sharp(imageBuffer).jpeg({ quality: options.quality || 90 }).toBuffer();
        }

        return imageBuffer;
    } finally {
        await page.close();
    }
}

/**
 * Crop PDF using pdf-lib and raster auto-crop
 */
export async function cropPdf(pdfBuffer, options = {}) {
    const croppedPng = await convertPdfToPng(pdfBuffer, { ...options, crop: true, format: 'png' });
    
    const pdfDoc = await PDFDocument.create();
    const pngImage = await pdfDoc.embedPng(croppedPng);
    const { width, height } = pngImage.scale(1);
    
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: width,
        height: height
    });
    
    const croppedPdfBytes = await pdfDoc.save();
    return {
        pdfBuffer: Buffer.from(croppedPdfBytes),
        pngBuffer: croppedPng
    };
}

/**
 * Convert Web URL or HTML to PDF
 */
export async function convertWebToPdf(urlOrHtml, options = {}) {
    const browser = await getBrowserInstance();
    const page = await browser.newPage();
    try {
        const isUrl = typeof urlOrHtml === 'string' && /^https?:\/\//i.test(urlOrHtml.trim());
        
        await page.setViewport({
            width: parseInt(options.viewportWidth || options.width || 1280),
            height: parseInt(options.viewportHeight || options.height || 800),
            deviceScaleFactor: 2
        });

        if (isUrl) {
            await page.goto(urlOrHtml.trim(), {
                waitUntil: options.waitUntil || 'networkidle2',
                timeout: 30000
            });
        } else {
            await page.setContent(urlOrHtml, {
                waitUntil: options.waitUntil || 'networkidle2',
                timeout: 30000
            });
        }

        const pdfBuffer = await page.pdf({
            format: options.pageFormat || options.format || 'A4',
            printBackground: options.printBackground !== false,
            landscape: !!options.landscape,
            margin: {
                top: options.marginTop || '10mm',
                bottom: options.marginBottom || '10mm',
                left: options.marginLeft || '10mm',
                right: options.marginRight || '10mm'
            }
        });

        return Buffer.from(pdfBuffer);
    } finally {
        await page.close();
    }
}

/**
 * Convert Web URL or HTML to PNG/JPG/WebP Screenshot
 */
export async function convertWebToImage(urlOrHtml, options = {}) {
    const browser = await getBrowserInstance();
    const page = await browser.newPage();
    try {
        const isUrl = typeof urlOrHtml === 'string' && /^https?:\/\//i.test(urlOrHtml.trim());
        
        await page.setViewport({
            width: parseInt(options.viewportWidth || options.width || 1280),
            height: parseInt(options.viewportHeight || options.height || 800),
            deviceScaleFactor: parseFloat(options.scale || 2)
        });

        if (isUrl) {
            await page.goto(urlOrHtml.trim(), {
                waitUntil: options.waitUntil || 'networkidle2',
                timeout: 30000
            });
        } else {
            await page.setContent(urlOrHtml, {
                waitUntil: options.waitUntil || 'networkidle2',
                timeout: 30000
            });
        }

        if (options.delay) {
            await new Promise(r => setTimeout(r, parseInt(options.delay)));
        }

        const format = (options.format || 'png').toLowerCase();
        let shotBuffer = await page.screenshot({
            fullPage: options.fullPage !== false,
            type: format === 'jpg' || format === 'jpeg' ? 'jpeg' : 'png'
        });

        if (options.crop) {
            shotBuffer = await autoCropImage(shotBuffer);
        }

        if (format === 'webp') {
            shotBuffer = await sharp(shotBuffer).webp({ quality: options.quality || 90 }).toBuffer();
        }

        return shotBuffer;
    } finally {
        await page.close();
    }
}

/**
 * Convert Image to PDF
 */
export async function convertImageToPdf(imageBuffer, options = {}) {
    // Standardize image to PNG/JPEG first
    const img = sharp(imageBuffer);
    const meta = await img.metadata();
    const pngBuf = await img.png().toBuffer();

    const pdfDoc = await PDFDocument.create();
    const embeddedImg = await pdfDoc.embedPng(pngBuf);
    
    let { width, height } = meta;
    if (!width || !height) {
        width = 595;
        height = 842;
    }

    const page = pdfDoc.addPage([width, height]);
    page.drawImage(embeddedImg, {
        x: 0,
        y: 0,
        width: width,
        height: height
    });

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
}

/**
 * Format image conversions (e.g. png to jpg, webp, resize)
 */
export async function convertImageFormat(imageBuffer, targetFormat = 'png', options = {}) {
    let pipeline = sharp(imageBuffer);
    
    if (options.width || options.height) {
        pipeline = pipeline.resize({
            width: options.width ? parseInt(options.width) : undefined,
            height: options.height ? parseInt(options.height) : undefined,
            fit: options.fit || 'inside'
        });
    }

    const fmt = targetFormat.toLowerCase();
    if (fmt === 'jpg' || fmt === 'jpeg') {
        pipeline = pipeline.jpeg({ quality: options.quality ? parseInt(options.quality) : 90 });
    } else if (fmt === 'webp') {
        pipeline = pipeline.webp({ quality: options.quality ? parseInt(options.quality) : 90 });
    } else if (fmt === 'png') {
        pipeline = pipeline.png({ quality: 100 });
    }

    return await pipeline.toBuffer();
}

/**
 * Convert Text String to formatted PDF
 */
export async function convertTextToPdf(textContent, options = {}) {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; font-size: 14px; line-height: 1.6; padding: 30px; white-space: pre-wrap; color: #1e293b; background: #fff; }
            </style>
        </head>
        <body>${textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</body>
        </html>
    `;
    return await convertWebToPdf(html, options);
}
