const express = require("express");
const dotenv = require("dotenv");
const Busboy = require("busboy");
const path = require("path");
const { Buffer } = require("buffer");

const {
  pickDropboxToken,
  uploadBufferToDropbox,
  createSharedLinkDirect
} = require("./lib/dropbox");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/test-upload", (req, res) => {
  const bb = Busboy({ headers: req.headers });


  let fileBuffers = [];
  let filename = "file.pdf";
  let gotFile = false;

  bb.on("file", (fieldname, file, info) => {
    gotFile = true;
    filename = info.filename || filename;

    file.on("data", (data) => fileBuffers.push(Buffer.from(data)));
  });

  bb.on("finish", async () => {
    if (!gotFile)
      return res.status(400).json({ success: false, error: "No file uploaded" });

    try {
      const buffer = Buffer.concat(fileBuffers);

      const { token } = await pickDropboxToken();

      const ts = Date.now();
      const safeName = filename.replace(/\s+/g, "_");
      const dropboxPath = `/campus-files/test/${ts}_${safeName}`;

      await uploadBufferToDropbox(token, buffer, dropboxPath);
      const url = await createSharedLinkDirect(token, dropboxPath);

      res.json({ success: true, dropboxPath, dropboxUrl: url });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  req.pipe(bb);
});

app.listen(PORT, () => {
  console.log("Server running at http://localhost:" + PORT);
});
