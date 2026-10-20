# House Hunting website

One project: the home page with the 3D cabin, the listings app (app.html), and the server (server/).

## Set up
1. Install Node.js 20.19 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill in the Google values and the review team's emails. Keep `.env` private.

## Run it on your computer
- Terminal 1: `npm run server` (the server, on port 3000)
- Terminal 2: `npm run dev`, then open http://localhost:5173

## Put it online
1. In `.env`, set `APP_URL` to your https address and set `NODE_ENV=production`. Run `npm run build`.
2. Run `npm run start`. It serves the site, the app and the API on one port.
3. Keep the `data/` and `uploads/` folders and back them up every day.

## Google sign-in
Add these as Authorized redirect URIs in Google Cloud Console:
- `http://localhost:5173/auth/google/callback` (testing on your computer)
- `https://yourdomain.com/auth/google/callback` (your live site)

Apple sign-in is switched off until its settings are added.

## Email
The thank-you email is sent on each new Google sign-in. Fill in the `SMTP_*` settings and `MAIL_FROM` in `.env` to send it. Until then, emails are written to the server log.

## Review checklist and verification
Reviewers tick all four checks on the Review page (photos, address, price, ownership), add a note, and then approve. A home shows the **Verified** badge only after approval with every check ticked. Editing a home clears its checks, so it is reviewed again.

Ownership documents are private. They are stored in `private/documents`, and only the review team can open them. Visitors can report a listing from its page, and open reports appear on the Review page.

## Map, owner inbox and saved searches
- **Map:** when you list or edit a home, click the map to place its pin. The Find a home page shows the homes on a map.
- **Owner inbox:** messages about your homes appear under My homes. You also get an email for each one, and you can mark them as read.
- **Saved searches:** on Find a home, choose your filters and tap Save this search. When a home that matches is approved, you get an email, once for each home.
- **Email:** these emails are sent once `SMTP_HOST` and the other `SMTP_*` settings in `.env` are filled in. Until then they appear in the server log.

After you unzip, run `npm install` once, because the map library was added.

## Reviews, host profiles and review alerts
- **Star reviews:** after someone messages one of an owner's homes with their Google email, they can rate the owner from 1 to 5 stars and leave a comment. Names are shown as first name and initial, and email addresses are never shown.
- **Trusted owner:** an owner with at least 5 reviews averaging 4.5 stars or more gets a Trusted owner badge.
- **Review team email:** when an owner sends a home for approval, every address in `ADMIN_EMAILS` gets the owner's details, the photo and document counts, and a link to the Review page.
- **Welcome email:** new members are greeted by name.
- **Moderation:** admins can hide any review from the owner's profile page.

## Replies and photo changes
- **Owner replies:** owners can reply to reviews on their own profile page.
- **Remove photos:** when editing a home, each photo has a Remove button. Removing a photo sends the home back to review, like any other change.

## Design and phone use
- **Map:** the map was removed from the Find a home page. The map picker on the List a home form stays, so owners can pin their home.
- **Buttons:** the buttons use an iPhone-style liquid glass look in the copper and charcoal colours of the site.
- **Phones:** the navigation becomes a tab bar at the bottom of the screen, and the forms and buttons are sized for touch.
- **Touch:** on phones, buttons and listing cards respond to a finger press with the same lift, shine and copper edge as the computer.

## Prices
All prices are shown in Kenya Shillings (KSh), for example KSh 45,000,000, KSh 85,000 a month, or KSh 6,500 a night.
