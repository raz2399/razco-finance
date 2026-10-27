# Razi-Nova Finance — iPhone app

The same numbers as the dashboard, on the phone, as a real installed app.
It calls the same endpoints the website does, so a figure here can never
disagree with a figure on the desktop.

## See it on your phone in two minutes

On your Mac, in this folder:

    npm install
    npx expo start

Install **Expo Go** from the App Store, then scan the QR code that appears
in the terminal. The app opens on your phone with live data. Every change
reloads instantly — this is for looking and deciding, not for shipping.

## Put it on your phone for real (TestFlight)

One-time, on your Mac:

    npm install -g eas-cli
    eas login            # your Expo account
    eas build:configure

Then, each time you want a new build:

    eas build --platform ios --profile production

The build runs on Expo's servers, not your Mac, and takes 10–20 minutes.
It will ask for your Apple Developer login and handle the certificates
itself. When it finishes:

    eas submit --platform ios --latest

That sends it to App Store Connect. From there it appears in TestFlight,
usually within the hour, and you install it like any app. TestFlight is
enough for your own use — you only need full App Store review if you want
other people to download it.

## What is in it

- **Home** — left after everything clears, in the bank, checks not cashed,
  income and expense for the week, what needs you, what you owe by vendor,
  checks still out. Pull down to refresh.
- **Record a delivery** — the four ways money actually leaves: COD by check,
  COD they draft, charge paid by check, charge they draft. A COD check will
  not save without its number, so the bank can match it later.

## Settings

`app.json` holds the API address under `extra.apiBase`. Point it at a
different site and the app follows, with no code change.
