const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("C:/Users/USER/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const root = "C:/Users/USER/Documents/Projetos/davantti/ml";

async function main() {
  let html = await fs.readFile(path.join(root, "views/publicidade.html"), "utf8");
  const cssApp = await fs.readFile(path.join(root, "public/css/ml-app.css"), "utf8");
  const cssAds = await fs.readFile(path.join(root, "public/css/product-ads.css"), "utf8");

  html = html
    .replace(/<link[^>]+ml-app\.css[^>]*>/i, `<style>${cssApp}</style>`)
    .replace(/<link[^>]+product-ads\.css[^>]*>/i, `<style>${cssAds}</style>`)
    .replace(/<script src="\/ml\/js\/ml-base\.js[^>]*><\/script>/i, "")
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js"><\/script>/i, "")
    .replace(/<script src="\/ml\/js\/product-ads\.js[^>]*><\/script>/i, "")
    .replace("</body>", "<style>body{background:#f3f6fb;}</style></body>");

  const previewPath = path.join(root, "tmp/publicidade-html-css-preview.html");
  const imagePath = path.join(root, "tmp/publicidade-html-css-preview.png");
  await fs.writeFile(previewPath, html, "utf8");

  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1300 },
    deviceScaleFactor: 1,
  });
  await page.goto(`file://${previewPath.replace(/\\/g, "/")}`, {
    waitUntil: "load",
  });
  await page.screenshot({ path: imagePath, fullPage: false });
  await browser.close();
  console.log(imagePath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
