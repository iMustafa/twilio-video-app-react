require('dotenv').config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const childProcess = require("child_process");
const config = require("./cmd");
const path = require("path");
const fs = require("fs");
require("puppeteer-stream");
const puppeteer = require("puppeteer");
const AccessToken = require("twilio").jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;
const CACHE_DURATION = 30000;
const TIME_SLEEP_MS = 50;
const MAX_SLEEP_COUNT = Infinity;

const PORT = process.env.PORT || 8081;

const MAX_ALLOWED_SESSION_DURATION = 14400;
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioApiKeySID = process.env.TWILIO_API_KEY_SID;
const twilioApiKeySecret = process.env.TWILIO_API_KEY_SECRET;

class UllServer {
  start() {
    this.app = express();
    this.app.use(cors());
    this.app.use(compression());
    this.app.use(express.static(path.join(__dirname, "build")));
    this.cache = {};
    this.listen();
  }

  listen() {
    this.acceptUpload();
    this.acceptDownload();

    this.app.get("/token", (req, res) => {
      const { identity, roomName } = req.query;
      const token = new AccessToken(
        twilioAccountSid,
        twilioApiKeySID,
        twilioApiKeySecret,
        {
          ttl: MAX_ALLOWED_SESSION_DURATION,
        }
      );
      token.identity = identity;
      const videoGrant = new VideoGrant({ room: roomName });
      token.addGrant(videoGrant);
      res.send(token.toJwt());
    });

    this.app.post("/start", (req, res, next) => {
      // const { room } = req.body;
      const room = "test";
      if (this.instance) {
        return res.status(200).json({ message: "already started" });
      }
      this.startTranscoding({ room });
      return res.status(200).json({
        message: `started manifest is at http://localhost:${PORT}/${room}/manifest.mpd`,
      });
    });

    this.app.post("/stop", (req, res, next) => {
      if (!this.instance) {
        return res.status(200).json({ message: "already stopped" });
      }
      this.stopTranscoding();
      return res.status(200).json({ message: "stopped" });
    });

    this.app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'build/index.html')));

    this.server = this.app.listen(PORT, () => {
      console.log(
        "ULL server listening... port",
        PORT,
        "POST to /start to start the transcoder"
      );
    });
  }

  async startTranscoding({ room }) {
    console.log(">> START TRANSCODING");
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto("https://www.youtube.com/watch?v=YRbKZRp2Fb4");
    await page.setViewport({
      width: 1920,
      height: 1080,
    });

    const stream = await page.getStream({ audio: true, video: true });

    this.instance = childProcess.spawn("ffmpeg", config({ room, port: PORT }));

    stream.pipe(this.instance.stdin);

    console.log(">> PIPPED INPUT");

    let isFirstData = true;
    this.instance.stderr.on("data", (data) => {
      if (isFirstData) {
        console.log("ffmpeg started");
        isFirstData = false;
      }
    });

    this.instance.on("error", () => {
      console.log("ffmpeg error");
    });

    this.instance.on("close", () => {
      console.log("ffmpeg closed");
    });
  }

  stopTranscoding() {
    this.instance.kill();
    this.instance = undefined;
  }

  acceptUpload() {
    this.app.put("/:filename", (req, res, next) => {
      const { filename } = req.params;

      try {
        if (!this.isCached(filename) || this.isPlaylist(filename)) {
          this.resetFileCache(filename);
        }
      } catch (e) {
        return res.status(400).send();
      }

      req.on("data", (chunk) => {
        try {
          this.cacheChunk(filename, chunk);
        } catch (e) {
          return res.status(400).send();
        }
      });

      req.on("end", () => {
        try {
          if (this.isTempCached(filename)) {
            this.scheduleClearCache(filename);
          }

          this.setDone(filename);

          console.log("Upload complete", filename);
          if (!this.isPlaylist(filename)) {
            res.end();
          }
        } catch (e) {
          return res.status(400).send();
        }
      });
    });
  }

  isCached(filename) {
    return !!this.cache[filename];
  }

  isChunk(filename) {
    return filename.startsWith("chunk") && filename.endsWith(".m4s");
  }

  isSegment(filename) {
    return filename.endsWith(".m4s");
  }

  isPlaylist(filename) {
    return filename.endsWith(".mpd");
  }

  isTempCached(filename) {
    return filename.startsWith("chunk");
  }

  scheduleClearCache(filename) {
    setTimeout(() => {
      this.clearFileCache(filename);
    }, CACHE_DURATION);
  }

  clearFileCache(filename) {
    delete this.cache[filename];
  }

  resetFileCache(filename) {
    this.cache[filename] = {
      done: false,
      chunks: [],
    };
  }

  cacheChunk(filename, chunk) {
    this.cache[filename].chunks.push(chunk);
  }

  getChunks(filename) {
    return this.cache[filename].chunks;
  }

  setDone(filename) {
    this.cache[filename].done = true;
  }

  isDone(filename) {
    return this.isCached(filename) && this.cache[filename].done === true;
  }

  async sleep() {
    return new Promise((resolve) => setTimeout(resolve, TIME_SLEEP_MS));
  }

  acceptDownload() {
    this.app.get("/healthcheck", (req, res) => {
      res.status(200).json({ message: "OK" });
    });

    this.app.get("/:filename", async (req, res, next) => {
      try {
        const { filename } = req.params;
        res.set("Transfer-Encoding", "chunked");

        if (this.isSegment(filename)) {
          res.set("Content-Type", "video/mp4");
          res.set("Cache-Control", "max-age=31536000");
        }

        if (this.isPlaylist(filename)) {
          res.set("Content-Type", "application/dash+xml");
        }

        let idx = 0;
        let sleepCt = 0;
        while (!this.isDone(filename)) {
          if (sleepCt > MAX_SLEEP_COUNT) {
            throw new Error("max sleep count reached");
          }
          if (!this.isCached(filename)) {
            await this.sleep();
            sleepCt++;
            continue;
          }

          const chunks = this.getChunks(filename).slice(idx);
          const length = chunks.length;
          if (length === 0) {
            await this.sleep();
            sleepCt++;
            continue;
          }
          idx += length;
          const buffer = Buffer.concat(chunks);
          res.write(buffer);
          res.flush();
          await this.sleep();
          sleepCt++;
        }

        const chunks = this.getChunks(filename).slice(idx);
        const length = chunks.length;
        if (length === 0) {
          res.end();
          return;
        }
        console.log("Download complete", filename);
        const buffer = Buffer.concat(chunks);
        res.write(buffer);
        res.flush();
        res.end();
      } catch (e) {
        console.log(e);
        return res.status(400).send();
      }
    });
  }

  stop() {
    this.server.close();
  }
}

const server = new UllServer();
server.start();
