# Media Review

A simple review site for media assets. People can browse a gallery grouped by project, comment on each asset, upload revised versions, and have approvers sign off.

- **Anyone with the link:** view, comment, upload new assets and revised versions (they just type their name, no login)
- **Approvers:** approve, request changes, reopen, and delete spam (name + personal passcode)
- **Statuses:** In Review → Ready for Approval (set automatically when a new version is uploaded) → Approved / Changes Requested
- **Media:** images, PDFs and videos up to 50 MB, or a pasted link (YouTube, Google Drive, Canva, …) for anything bigger

If `config.js` is left blank, the site runs in **demo mode**, which saves data in your own browser only. Open `index.html` to try it. The demo approver passcode is `demo`.

---

## Setup (about 15 minutes, all free)

### 1. Create the database (Supabase)
1. Go to https://supabase.com, sign up, and click **New project**. Pick any name and region, and save the database password somewhere.
2. When it's ready, open **SQL Editor → New query**, paste the whole of `supabase/schema.sql`, and click **Run**.
3. Add your approvers. Paste this into a new query, edit the names and passcodes, and click **Run**:
   ```sql
   insert into public.approvers (name, passcode_hash) values
     ('Daven', extensions.crypt('pick-a-passcode', extensions.gen_salt('bf'))),
     ('Person2', extensions.crypt('another-passcode', extensions.gen_salt('bf')))
   on conflict (name) do update set passcode_hash = excluded.passcode_hash;
   ```
   Give each approver their name and passcode privately. To remove an approver later, run `delete from public.approvers where name = 'Person2';`
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.

### 2. Connect the site
Open `config.js` and paste in those two values:
```js
SUPABASE_URL: "https://xxxx.supabase.co",
SUPABASE_ANON_KEY: "eyJ...",
SITE_TITLE: "Diwali Exhibition – Media Review",
```
The anon key is designed to be public. The database rules in `schema.sql` decide what it's allowed to do.

### 3. Publish on GitHub Pages
1. On GitHub, click **New repository**, name it (e.g. `media-review`), and make it **Public**. Pages on private repos needs a paid plan.
2. Click **Add file → Upload files**, drag in everything in this folder (`index.html`, `app.js`, `styles.css`, `config.js`, `README.md`, and the `supabase` folder), then click **Commit**.
3. Go to **Settings → Pages**. Under **Source**, choose **Deploy from a branch**, then branch `main`, folder `/ (root)`, and click **Save**.
4. After a minute or two, the site is live at `https://<your-username>.github.io/media-review/`. Share that link.

---

## Day-to-day use
- **Add an asset:** click **+ New asset**, pick a project (or create one), give it a title, then upload a file or paste a link.
- **Comment:** open an asset, type your name and a comment. Comments are tagged with the version being viewed.
- **Revise:** on the asset page, click **Upload revised version**. It becomes v2, v3, … and is marked **Ready for Approval**.
- **Approve:** click **Approver? Sign in to approve**, enter your name and passcode, then click **Approve vN** or **Request changes**. You stay signed in until the tab is closed.
- Older versions stay available through the version tabs. The approved version shows a ✓.
- Uploading a new version after approval reopens the asset for review.

## Limits & notes
- Supabase free tier: 1 GB of file storage, 50 MB per file. Put long videos on YouTube (unlisted) or Google Drive (set to "Anyone with the link") and paste the link.
- Free Supabase projects pause after about a week with no activity. Open the Supabase dashboard and click **Restore** if that happens. No data is lost.
- With no login, anyone who has the link can comment and upload. Keep the link within your group. Approvers can delete spam comments (✕) and assets.
- Deleting an asset removes its record but leaves the uploaded files in storage. Clean them up in Supabase → Storage → `media` if space gets tight.
