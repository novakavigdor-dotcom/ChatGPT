# Umami Bingo

A customer loyalty app with personal QR codes, an owner scanner, and an illustrated 4×4 food bingo card. The home screen uses black ink food drawings, bold labels, cream squares and black grid lines. All 16 squares are food categories. Each completed row, column, or diagonal of four stamps unlocks its own 10% discount: four rows, four columns and two diagonals can earn ten 10% discounts per card. Collect all 16 stamps to unlock a separate 25% discount. Each line reward and the full-card reward can be used once, on separate purchases; discounts cannot be combined. Using a reward does not block the other rewards. The customer's personal QR code sits above the grid, leaving all 16 food squares available.

## Deploy the working app on Netlify

Use a **GitHub-connected Netlify deployment**. Uploading the HTML or a static folder alone does not deploy the API needed for signup and shared bingo cards.

1. Connect this repository to the Netlify site and deploy the `main` branch. The included `netlify.toml` sets the build command to `npm run build:web`, the publish directory to `dist`, and the Functions directory to `netlify/functions`.
2. Open `/api/health` on the deployed site; it should return `{"ready":true}`.
3. Open `/owner`, enter your configured owner access code, and allow camera access. Give customers the same site's `/customer` address.

Netlify automatically provides the credentials for Netlify Blobs; no database key, owner-password environment setting, or extra service signup is needed. The function uses a site-wide Blobs store so separate customer accounts survive deployments and cold starts. Strong reads and conditional writes preserve simultaneous staff updates. The owner access code is verified by the backend against a private server-side verifier; the plaintext code is not embedded in public browser files. Public first-owner setup is disabled on Netlify.

The `dist` directory contains only public HTML, styles, browser JavaScript, images and fonts. Server code is deployed separately as a Function. Private state, passwords, environment files, and server source are never published as static files.

## Customer and owner workflow

1. New customers open `/customer` and create an account with first name, last name, and email. Returning customers choose **Sign in** and enter only their last name and email. The app does not send email or verify the address.
2. At the counter, the customer shows the personal QR code above their bingo card, or their public customer code. Tap the QR code to enlarge it.
3. The owner opens `/owner`, enters their owner access code, allows the camera, scans the customer's QR code or enters the customer code, selects the qualifying food squares, and confirms the visit.
4. The customer's card checks for updates every 15 seconds while the app is visible; polling pauses in hidden tabs. The owner can select and confirm an eligible discount. Each confirmation uses only that selected reward; one discount is allowed per purchase and discounts cannot be combined. Close the card after recording a discount, then reopen it for a separate purchase to use another available reward.

After signing in, the owner can browse **Customer accounts** to see all created customer accounts, load additional pages, refresh the list, and open any customer’s bingo. Account names and email addresses are available only in the authenticated owner workspace.

After signing in, the owner can also choose **Find a customer** and search by name or email. Search returns up to 20 matching accounts; refine the query to narrow the results, then choose **Open bingo**. Customer search requires an authenticated owner session. The scanner keeps running after an unrelated QR code or a code with no matching customer, so staff can scan the correct code without restarting it.

Confirming only previously collected stamps leaves visit history and direct-order credit unchanged. Reward redemptions are recorded permanently: each of the ten lines has one 10% reward, plus one 25% full-card reward per card. An older first-line 10% redemption counts as one used line reward, so a fully stamped card with that redemption has nine unused 10% rewards and its separate 25% reward. An older recorded 25% redemption leaves all ten line rewards available when their lines are complete. Older records with an unknown original reward percentage retain a generic previous-reward history and keep further rewards blocked rather than guessing which discount was used or automatically granting a duplicate.

The public QR code identifies the customer's bingo card to staff; it does not sign the customer in by itself. Customers use their last name and email to reopen the same account on another browser. Anyone who knows that last name and email can open the account, as intended for convenient access.

Green squares in the owner's purchase view are saved stamps; red squares are selections for the current purchase. To correct a mistaken stamp, open the customer's card and choose **Correct stamps** above the grid or **Correct saved stamps** beneath it. Confirm or untick any red purchase selections first. In correction mode, untick the mistaken saved squares. Choose **Remove N stamps**, review the warning, then choose **Confirm removal**. Nothing changes until confirmation. If another staff member changed the card, choose **Reload bingo** and review the current stamps before retrying. The customer sees the corrected card automatically. Corrections preserve visit and redemption history. Removing or re-adding stamps does not reset a used reward. An unused reward is available only while its qualifying line or full card is complete.

To start a fresh card for one customer, open their bingo in the owner workspace and choose **Reset card**. Review the confirmation, then choose **Confirm reset**. This clears that card’s stamps and used-discount status for a new card. The customer keeps their account and personal QR code; previous card and redemption records remain in private history. A changed card must be reloaded before it can be reset. Customers cannot reset their own cards.

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

Customer advertisements are in [marketing](marketing/): a [printable Letter poster](marketing/Umami-Bingo-Poster.pdf), a [1080×1350 social image](marketing/Umami-Bingo-Ad.png), and [caption text](marketing/caption.md). Both advertisements include a real QR code pointing to the customer app. The editable layout is [poster.html](marketing/poster.html); the source download also includes these marketing files.

```sh
npm test
npm run build:web
npm run build
```

`build:web` creates only the public `dist` directory for Netlify. `build` creates `Umami-Bingo.html` in the parent folder and, with Python 3 available, `umami-bingo.zip` containing the app and source, including deployment configuration and the private backend verifier module. Downloads exclude private customer records, session data, and the plaintext owner access code. The verifier is packaged with the server source and Function, never the public site or standalone HTML.

The server cleans up expired sessions and retry receipts older than 30 days. New visit, correction, and redemption requests use timestamped UUIDv7 identifiers. Redemption history stays on the account after retry receipts expire. If an old request identifier has no retained receipt and is rejected, refresh the owner page before submitting the action again.

The standalone HTML opens in a current Chrome or Edge browser without installation. It embeds browser code, QR tools, images, fonts, and licenses. It is an offline demonstration confined to the same browser; it cannot sync devices or authenticate the owner against the server. Use the hosted app for customer accounts and the shared owner system.

The app does not collect payments or send food orders. Staff confirm qualifying purchases manually. Confirm eligibility and publish the restaurant's promotion terms before using the discounts with customers.
