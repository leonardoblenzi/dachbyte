const path = require("path");
const { chromium } = require("C:/Users/USER/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

async function main() {
  const root = "C:/Users/USER/Documents/Projetos/davantti";
  const htmlPath = path.join(root, "tmp/publicidade-decision-preview.html");
  const imagePath = path.join(root, "ml/tmp/publicidade-decision-preview.png");

  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 2300 },
    deviceScaleFactor: 1,
  });
  await page.goto(`file://${htmlPath.replace(/\\/g, "/")}`, { waitUntil: "load" });
  await page.screenshot({ path: imagePath, fullPage: false });
  await browser.close();
  console.log(imagePath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
