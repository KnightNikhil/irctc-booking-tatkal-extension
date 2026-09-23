# IRCTC Booking Assistant

Local Chrome extension for speeding up IRCTC bookings without storing passwords or automating human-only steps.

## What it does

- Stores journey, up to 4 passengers, preferred/fallback class dropdowns, and booking preferences.
- Shows a small IRCTC-page panel that asks for a target train number before assisted booking starts.
- Has a `Schedule` button that arms a configured `HH:MM:SS` IST timer, shows a countdown, and resumes the current page when the time is reached.
- Fills the IRCTC search form.
- Searches, moves to the train-list page, and checks the requested train number in your configured class order.
- Proceeds only when the selected journey date shows confirmed-style availability.
- Clicks `Book Now` for the matching train/class and advances until IRCTC reaches login, passenger details, payment, or another human checkpoint.
- Fills the IRCTC user ID, then pauses for password and CAPTCHA.
- Attempts to fill passenger preferences, disable auto-upgrade, choose no insurance, and prefer UPI/QR where IRCTC exposes those controls.
- Uses bounded backoff retries for transient IRCTC errors such as temporary failures or rate-limit messages.

## What it will not do

- It does not store or type your password.
- It does not solve CAPTCHA or bypass anti-bot protections.
- It does not bypass IRCTC rate limits.
- It does not enter OTPs, UPI PINs, or payment credentials.
- It does not click final payment confirmation for you.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:
5. Pin `IRCTC Booking Assistant` from the extensions menu.
6. Open or reload IRCTC in the same Chrome profile.

## Use

1. Open IRCTC in Chrome.
2. Use the floating `IRCTC Assistant` panel on the IRCTC page.
3. Enter the train number you want.
4. Click `Fill Search` to only fill the search form, or `Start Assist` to fill, search, target that train, and select confirmed availability.
5. When IRCTC asks for password, CAPTCHA, OTP, or payment, complete it manually.
6. Click `Continue` in the floating page panel after a manual step or failure. It resumes from the current IRCTC page and keeps going until the next checkpoint.

The extension popup still works for editing saved defaults, but the on-page panel avoids Chrome popup rendering issues during booking.

## Current defaults

- From: `PUNE JN. - PUNE (PUNE)`
- To: `RATLAM JN. - RTM`
- Date: `2026-11-21`
- Train number: enter before using `Start Assist`
- Passenger 1: `NAME`, age `XX`, Male
- Fallback class order: `SL`, `3A`, `2A`
- Scheduled auto-continue time: blank by default
- No insurance
- Auto-upgrade disabled
- UPI preferred

IRCTC changes its page markup frequently. If a future page update breaks a field, update the saved settings first, then retry. If the selector logic needs adjustment, edit `content.js`.
