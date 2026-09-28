import { it } from "vitest";
import { save, codes, log } from "./zzReviewHelpers";

function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const INDENTS = ["", "", "", " ", "  ", "   ", "   ", "   ", "    ", "     ", "      ", "\t"];
const KINDS = ["1. W", "2. W", "2) W", "b. W", "10. W", "- W", "- ```", "```", "```", "~~~", "````", "```js", "- [ ] W", "> W", "> ```", "W", "W", "", "", "# W", "1. ```", "1. - ```", "* - ~~~", "-    ```", "``` x"];
const idRe = /w\d+/g;
it("fuzz parent vs head", () => {
  const r = rng(12345);
  let n = 0, found = 0, unstable = 0;
  for (let i = 0; i < 4000 && found < 40; i++) {
    let id = 0;
    const len = 2 + Math.floor(r() * 7);
    const lines: string[] = [];
    for (let j = 0; j < len; j++) {
      const k = KINDS[Math.floor(r() * KINDS.length)];
      const ind = j === 0 ? "" : INDENTS[Math.floor(r() * INDENTS.length)];
      lines.push(k === "" ? "" : ind + k.replace("W", "w" + (++id)));
    }
    if (!/^\d+[.)]|^[a-z][.)]/.test(lines[0])) lines[0] = "1. w0";
    const md = lines.join("\n");
    if (!/```|~~~/.test(md)) continue;
    n++;
    const ids = md.match(idRe) ?? [];
    let h: string, p: string;
    try { h = save(md); } catch (e) { log("r2.txt", "HEAD THROW " + JSON.stringify(md) + " " + e); found++; continue; }
    try { p = save(md, true); } catch { p = ""; }
    const lostH = ids.filter((x) => !h.includes(x));
    const lostP = ids.filter((x) => !p.includes(x));
    if (lostH.length > lostP.length) { found++; log("r2.txt", "LOSS " + JSON.stringify(md) + "\n  head " + JSON.stringify(h) + " lost " + lostH + "\n  parent " + JSON.stringify(p)); }
    const h2 = save(h);
    const p2 = p ? save(p, true) : p;
    if (h2 !== h && p2 === p) {
      const cs = codes(md);
      const excluded = cs.some((c) => /^\s{0,3}(```|~~~)/m.test(c));
      if (!excluded) { unstable++; found++; log("r2.txt", "UNSTABLE(parent stable) " + JSON.stringify(md) + "\n  h1 " + JSON.stringify(h) + "\n  h2 " + JSON.stringify(h2) + "\n  p " + JSON.stringify(p)); }
    }
  }
  log("r2.txt", `done n=${n} found=${found} unstable=${unstable}`);
}, 600000);
