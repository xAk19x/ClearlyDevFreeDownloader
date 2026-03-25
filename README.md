# ClearlyDev Free Downloader Chrome Extension

This repository contains a Chrome extension that automates two actions on [clearlydev.com](https://clearlydev.com):

1. **Add all free products (`$0.00`) to cart**.
2. **Download all assets from the logged-in user's purchased library**.

## Features

- Detects whether the user appears logged in before running actions.
- Crawls the Roblox product catalog page (`/shop/roblox/roblox-games`) with pagination, opens each product page in a background tab, and adds only free items to cart.
- Crawls purchased library pages and triggers downloads for every detected asset link.
- Includes a popup UI with two buttons:
  - `Add all free products to cart`
  - `Download all library assets`

## Install in Chrome (Developer Mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.

## Usage

1. Sign in to `https://clearlydev.com` in Chrome.
2. Open the extension popup.
3. Click one of the automation buttons.
4. Keep Chrome open while the workflow runs.

## Notes

- The extension uses DOM selectors and URL heuristics that may require updates if ClearlyDev changes its website markup.
- Some downloads may open in new tabs depending on browser and server behavior.
- Use responsibly and in accordance with the target site's terms.
