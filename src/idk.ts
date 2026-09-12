import fs from 'fs';

import puppeteer from 'puppeteer';

import { PuppeteerScreenRecorder, } from './index'

(async () => {
  const fileStream = fs.createWriteStream('/dev/null');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium-browser',
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // 1. Disable the new HTTPS-First behavior
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,AutoupgradeMixedContent,BlockInsecurePrivateNetworkRequests',
      // 2. Allow insecure content to be loaded
      '--allow-running-insecure-content',
      // 3. Ignore certificate errors (extra precaution)
      '--ignore-certificate-errors',
      // THIS IS THE FIX FOR ORB/CORB:
      '--disable-web-security',
    ],
    dumpio: true,
  });
  const page = await browser.newPage();
  await page.setViewport({
    width: 640,
    height: 480,
  });

  // Log failures (DNS, Connection Refused, etc)
  page.on('requestfailed', request => {
    console.log(`!! Request Failed: ${request.url()} | Error: ${request.failure().errorText}`);
  });
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();

    if (url.includes('geocode.arcgis.com') && url.startsWith('http://')) {
      // Manually force the request to HTTPS before Chromium sees the 307
      // we ran into this when requesting 
      // http://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest?callback=....
      // we would get Error: net::ERR_ABORTED.
      // on a normal browser, this call returns 307 to the https equivalent. we just go for
      // https below, to get around ERR_ABORTED. welcome to 2026
      console.log('Replacing HTTP with HTTPS for ArcGIS to bypass 307 Abort');
      request.continue({
        url: url.replace('http://', 'https://')
      });
      return;
    }
    request.continue();
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');

  const recorder = new PuppeteerScreenRecorder(page, { quality: 50, aspectRatio: '16:9' });

  // forget passing in a stream like this lets just hack the code to write to ffmpeg frame by frame
  await recorder.startStream(fileStream); // supports extension - mp4, avi, webm and mov

  // Create a new URL object
  const url = new URL(process.env.WS4KP_URL);

  // Append the query parameter
  url.searchParams.append('location', process.env.WS4KP_ZIPCODE);

  await page.goto(url.href);
  await page.evaluate(() => {
  const element = document.getElementById('divTwc');
  if (element) {
    element.scrollIntoView({
      behavior: 'instant', // Instant jump without waiting for animation frames
      block: 'center',     // Vertically center the element in the viewport
      inline: 'center',    // Horizontally center the element in the viewport
    });
  }
  });
})();