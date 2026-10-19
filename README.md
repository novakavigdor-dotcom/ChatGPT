# Umami Passport

A restaurant passport with customer QR codes and an owner dashboard. Customers explore six food categories: maki, poke or onigiri, noodles or soup, prepared fish, platters, and chef’s choice. A completed passport unlocks access to the Secret Passport Roll; direct ordering earns a separate badge.

## Start on Windows

Install Node.js 20 or newer. On GitHub, choose **Code → Download ZIP**, extract it, and open the folder containing `package.json`. If you downloaded the separate `umami-passport.zip` app bundle instead, use its `source` folder. Open a terminal in that folder and paste:

```powershell
$env:UMAMI_DATA_DIR = "$env:LOCALAPPDATA\UmamiPassport"
npm start
```

No dependency installation is required. The server uses Node.js standard modules and the browser QR tools are bundled locally.

Open these addresses:

- Owner: **http://localhost:3000/owner**
- Customer: **http://localhost:3000/customer**

On the first owner visit, create an owner password with at least 10 characters. If the host already provides `OWNER_PASSWORD`, sign in with that password instead. Complete owner setup before sharing a public app address.

## Use it at the restaurant

1. Host the Node server at a shared HTTPS address, then finish owner setup at `/owner`.
2. Give customers the same app address ending in `/customer`. Each customer opens their own passport and shows its QR code or customer code.
3. The owner signs in at `/owner`, scans that QR code or enters the customer code, and adds the qualifying stamps after checking the purchase.
4. Stamps appear automatically within a few seconds while the customer’s passport is open. The customer and owner must use the same running server.

Phone camera scanning requires HTTPS and permission to use the camera. `localhost` works for testing on the computer running the app. On a phone, `localhost` refers to the phone itself; use the shared hosted address. Manual code entry is available if camera access is unavailable.

## Data and hosting

The server saves customers, stamps, and owner authentication in a private data directory outside the public checkout: `/workspace/umami-data` on Linux, or `UmamiPassport` inside Windows Local AppData by default. Set `UMAMI_DATA_DIR` to a private writable directory if your host uses another location. Keep that directory on persistent storage and back it up. Source ZIP downloads do not include customer records or owner credentials.

A customer’s public QR code identifies the passport to the owner; it does not log a customer in or restore their passport in another browser. Each customer must keep using the same browser and retain its cookies. Clearing browser data creates a new passport; cross-device customer recovery is not implemented.

The server listens on port 3000 by default; set `PORT` if your host requires another port. Run one server process with persistent disk; the JSON store does not support multiple replicas or stateless serverless hosting. Place it behind an HTTPS proxy that preserves the original Host header, and set `UMAMI_HTTPS=1` to use Secure cookies. Provide `OWNER_PASSWORD` through the host’s private environment settings to initialize the first owner without an open setup page. This variable only initializes a new store; it does not overwrite an existing owner password.

## Offline demonstration

Download **Umami-Passport.html** and double-click it in a current Chrome or Edge browser. No installation is required. This standalone file embeds the app, QR tools, styles, images, fonts, and licenses. It provides a same-browser demonstration; it cannot sync devices or provide a shared owner system. Browser privacy settings may prevent saving local-file progress.

## Development

```sh
npm test
npm run build
```

The build writes `Umami-Passport.html` into the parent directory of this checkout. With Python 3 available, it also writes `umami-passport.zip` containing the standalone demo and source code. The build keeps ES modules isolated through an import map and embeds public assets before packaging. The ZIP explicitly excludes private runtime data and environment files.

Menu prices and orders remain a prototype: no payment is collected and no food order is sent to the restaurant. Owner approval records loyalty progress, without a POS or purchase-verification integration. Confirm category eligibility and publish reward terms before using the programme with customers.
