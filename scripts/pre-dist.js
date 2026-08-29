#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const needles = ["Chris-Custom-FLC/data", "com.phenomen.flc"];

function fail(msg) {
  console.error(`pre-dist: ${msg}`);
  process.exit(1);
}

function walkJsHtml(dir, acc) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkJsHtml(p, acc);
    else if (/\.(js|html)$/.test(name)) acc.push(p);
  }
}

if (path.basename(repo) === "Chris-Custom-FLC") {
  fail("refusing to run inside original Chris-Custom-FLC");
}

if (fs.existsSync(path.join(repo, "data", "servers.json"))) {
  fail("data/servers.json exists — remove it before packaging");
}

const logsDir = path.join(repo, "logs");
if (fs.existsSync(logsDir)) {
  const logs = fs.readdirSync(logsDir).filter((f) => f.endsWith(".log"));
  if (logs.length) {
    fail("logs/*.log exist — delete logs before packaging");
  }
}

const files = [];
walkJsHtml(path.join(repo, "electron"), files);
walkJsHtml(path.join(repo, "src"), files);
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const needle of needles) {
    if (text.includes(needle)) {
      fail(`${path.relative(repo, file)} contains forbidden path: ${needle}`);
    }
  }
}

console.log("pre-dist: ok");
