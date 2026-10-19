# Umami Passport

A customer loyalty app with personal QR codes, an owner scanner, and a 3×3 food bingo card. A completed line earns 10% off; all eight food squares earn 25% off. The centre square is free.

## Deploy the working app on Netlify

Use a **GitHub-connected Netlify deployment**. Uploading the HTML or a static folder alone does not deploy the API needed for signup and shared passports.

1. Connect this repository to the Netlify site and deploy the `main` branch. The included `netlify.toml` sets the build command to `npm run build:web`, the publish directory to `dist`, and the Functions directory to `netlify/functions`.
2. In the site's **Project configuration → Environment variables**, add a private `OWNER_PASSWORD` of 10–256 characters, available to Functions. Redeploy after adding it. Do not put the password in a source file or chat.
3. Open `/api/health` on the deployed site; it should return `{"ready":true}`. Open `/owner` and sign in with your owner password. Give customers the same site's `/customer` address.

Netlify automatically provides the credentials for Netlify Blobs; no database key or extra service signup is needed. The function uses a site-wide Blobs store so passports survive deployments and cold starts. Strong reads and conditional writes preserve simultaneous staff updates. Public first-owner setup is disabled on Netlify; `OWNER_PASSWORD` initializes the first owner. It does not overwrite an existing owner password.

The `dist` directory contains only public HTML, styles, browser JavaScript, images and fonts. Server code is deployed separately as a Function. Private state, passwords, environment files, and server source are never published as static files.

## Customer and owner workflow

1. Customers open `/customer`, enter first name, last name, and email, then save their private recovery code. Email is recorded for the account; the app does not send email or verify the address.
2. At the counter, the customer shows their QR code or public customer code.
3. The owner signs in at `/owner`, scans the QR code or enters the customer code, selects the qualifying food squares, and confirms the visit.
4. The customer's card updates automatically within a few seconds. The owner can record the eligible discount redemption.

The public QR code identifies a passport to staff. It does not sign the customer in. Customers use their email and **private recovery code** to reopen the same passport on another browser. Keep that recovery code private and save it when shown; the app does not email it.

Phone camera scanning requires HTTPS and camera permission. Manual customer-code entry works when scanning is unavailable. Owner and customer devices must use the same deployed site.

## Start locally on Windows

Install Node.js **22.12 or newer**. On GitHub choose **Code → Download ZIP**, extract it, and open the folder containing `package.json`. For the separate `umami-passport.zip` bundle, open its `source` folder. Open a terminal there and paste:

```powershell
npm ci
npm start
```

- Owner: **http://localhost:3000/owner**
- Customer: **http://localhost:3000/customer**

Local Node startup allows first-run owner setup with a password of 10–256 characters. You can instead initialize it through `OWNER_PASSWORD`. Local data is stored outside the public checkout: `/workspace/umami-data` on Linux or `UmamiPassport` in Windows Local AppData. Set `UMAMI_DATA_DIR` to change that path. Keep it on persistent disk and back it up. Local JSON storage supports one server process; Netlify hosting uses Blobs instead.

`localhost` refers to the current device. Use the deployed HTTPS address to connect a phone to the app. For another Node host, provide persistent disk and an HTTPS proxy that preserves Host, set `UMAMI_HTTPS=1`, and set `PORT` if required.

## Development and downloads

```sh
npm test
npm run build:web
npm run build
```

`build:web` creates only the public `dist` directory for Netlify. `build` creates `Umami-Passport.html` in the parent folder and, with Python 3 available, `umami-passport.zip` containing the app and source, including deployment configuration. Downloads exclude customer data and credentials.

The standalone HTML opens in a current Chrome or Edge browser without installation. It embeds browser code, QR tools, images, fonts, and licenses. It is an offline demonstration confined to the same browser; it cannot sync devices. Use the hosted app for customer accounts and the shared owner system.

The app does not collect payments or send food orders. Staff confirm qualifying purchases manually. Confirm eligibility and publish the restaurant's promotion terms before using the discounts with customers.
