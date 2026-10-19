# Umami Bingo

A customer loyalty app with personal QR codes, an owner scanner, and a 4×4 food bingo card. All 16 squares are food categories. Complete any row, column, or diagonal of four stamps for 10% off, or collect all 16 for 25% off. Each card can redeem one reward. The customer's personal QR code sits above the grid, leaving all 16 food squares available.

## Deploy the working app on Netlify

Use a **GitHub-connected Netlify deployment**. Uploading the HTML or a static folder alone does not deploy the API needed for signup and shared bingo cards.

1. Connect this repository to the Netlify site and deploy the `main` branch. The included `netlify.toml` sets the build command to `npm run build:web`, the publish directory to `dist`, and the Functions directory to `netlify/functions`.
2. Open `/api/health` on the deployed site; it should return `{"ready":true}`.
3. Open `/owner`, enter your configured owner access code, and allow camera access. Give customers the same site's `/customer` address.

Netlify automatically provides the credentials for Netlify Blobs; no database key, owner-password environment setting, or extra service signup is needed. The function uses a site-wide Blobs store so separate customer accounts survive deployments and cold starts. Strong reads and conditional writes preserve simultaneous staff updates. The owner access code is verified by the backend against a private server-side verifier; the plaintext code is not embedded in public browser files. Public first-owner setup is disabled on Netlify.

The `dist` directory contains only public HTML, styles, browser JavaScript, images and fonts. Server code is deployed separately as a Function. Private state, passwords, environment files, and server source are never published as static files.

## Customer and owner workflow

1. Customers open `/customer`, enter first name, last name, and email, then save their private recovery code. Email is recorded for the account; the app does not send email or verify the address.
2. At the counter, the customer shows the personal QR code above their bingo card, or their public customer code. Tap the QR code to enlarge it.
3. The owner opens `/owner`, enters their owner access code, allows the camera, scans the customer's QR code or enters the customer code, selects the qualifying food squares, and confirms the visit.
4. The customer's card updates automatically within a few seconds. The owner can record the eligible discount redemption.

The public QR code identifies the customer's bingo card to staff. It does not sign the customer in. Customers use their email and **private recovery code** to reopen the same account on another browser. Keep that recovery code private and save it when shown; the app does not email it.

To correct a mistaken stamp, open the customer's card, choose **Correct stamps**, and untick the mistaken saved squares. Choose **Remove N stamps**, review the warning, then choose **Confirm removal**. Nothing changes until confirmation. If another staff member changed the card, choose **Reload bingo** and review the current stamps before retrying. The customer sees the corrected card automatically. Corrections preserve visit and redemption history; removing stamps does not reset a redeemed reward or allow another redemption on the same card.

Phone camera scanning requires HTTPS and camera permission. Manual customer-code entry works when scanning is unavailable. Owner and customer devices must use the same deployed site.

## If the Owner button or signup does not work

Open `/api/health` on the same site. A working deployment returns JSON containing `"ready":true`. If it returns a webpage, a 404, or a storage error, deploy the complete GitHub-connected project with Netlify Functions; uploading a static folder or the standalone HTML cannot provide account storage or owner authentication. Check the Netlify deployment and Function logs if the function is unavailable.

After the deployment completes, refresh the app and open `/owner` directly. Successful access-code verification opens the scanner. Allow the browser's camera prompt, or enter the customer's code manually. Camera access on a phone requires the deployed HTTPS address.

## Start locally on Windows

Install Node.js **22.12 or newer**. On GitHub choose **Code → Download ZIP**, extract it, and open the folder containing `package.json`. For the separate `umami-bingo.zip` bundle, open its `source` folder. Open a terminal there and paste:

```powershell
npm ci
npm start
```

- Owner: **http://localhost:3000/owner**
- Customer: **http://localhost:3000/customer**

Use the configured owner access code at `/owner`. Local data is stored outside the public checkout: `/workspace/umami-data` on Linux or `UmamiPassport` in Windows Local AppData. Set `UMAMI_DATA_DIR` to change that path. Keep it on persistent disk and back it up. Local JSON storage supports one server process; Netlify hosting uses Blobs instead.

`localhost` refers to the current device. Use the deployed HTTPS address to connect a phone to the app. For another Node host, provide persistent disk and an HTTPS proxy that preserves Host, set `UMAMI_HTTPS=1`, and set `PORT` if required.

## Development and downloads

```sh
npm test
npm run build:web
npm run build
```

`build:web` creates only the public `dist` directory for Netlify. `build` creates `Umami-Bingo.html` in the parent folder and, with Python 3 available, `umami-bingo.zip` containing the app and source, including deployment configuration and the private backend verifier module. Downloads exclude private customer records, session data, and the plaintext owner access code. The verifier is packaged with the server source and Function, never the public site or standalone HTML.

The standalone HTML opens in a current Chrome or Edge browser without installation. It embeds browser code, QR tools, images, fonts, and licenses. It is an offline demonstration confined to the same browser; it cannot sync devices or authenticate the owner against the server. Use the hosted app for customer accounts and the shared owner system.

The app does not collect payments or send food orders. Staff confirm qualifying purchases manually. Confirm eligibility and publish the restaurant's promotion terms before using the discounts with customers.
