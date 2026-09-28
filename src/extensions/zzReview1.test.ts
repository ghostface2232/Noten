import { it } from "vitest";
import { save, codes, log } from "./zzReviewHelpers";
const cases: string[] = [
  "1. a\n   ```\n   code\n   1. nested\n2. b",
  "1. a\n   ```\n   2. x\n  ```\n   3. y\n   ```",
  "1. a\n  ```\n   2. x\n  ```\n   3. y",
  "1. a\n\t```\n\t2. x\n\t```",
  "10. a\n    ```\n    2. x\n    ```",
  "1.    a\n      ```\n      2. x\n      ```",
  "1. a\n   -    ```\n        2. x\n        ```",
  "1. a\n   - [ ] t\n     ```\n     2. x\n     ```",
  "1. - [ ] ```\n         2. x\n         ```",
  "1. a\n   > ```\n   > 2. x\n   > ```",
  "1. a\n\n      ```\n      code\n        ```\n   2. b",
  "1. a\n\n     ```\n     code\n        ```\n     2. b\n     3. c",
  "1. a\n   ```\n   code\n  more\n   2. x\n   ```",
  "1. ```\ncode\n   2. x\n   ```",
  "i. a\n   ```\n   ii. x\n   ```\nii. b",
  "1. a\n   <div>\n   ```\n   </div>\n\n   2. b",
  "1. a\n   ```\n   2. x\n   ```\n   - b\n   3. c",
  "1. a\n   ~~~ `x`\n   2. y\n   ~~~",
  "1. a\n   ``` `x`\n   2. y\n   ```",
  "1. a\n   ```\n   2. x\n   ``` trailing\n   3. y\n   ```",
  "1. a\n   - ```\n   2. x\n     ```",
  "1. a\n   ```\n\n2. b",
  "1. a\n   ```\n   2. b\n\n   3. c\nlazy",
  "1. a\n\n   ```\n   x\n   ```\nlazy",
  "1. a\n   * - ```\n       2. x\n       ```\n   2. y",
  "1. a\n   - ```\n     x\n    ```\n     2. y",
  "1. a\n   ```\n   x\n    ```\n   2. y",
  "1. a\n   ````\n   ```\n   2. x\n   ```\n   3. y",
  "1. a\n   ```\n   x\n   ```\n   ```\n   2. y\n   ```",
  "1. a\n    ```\n    2. x\n    ```",
  "1. a\n     ```\n     2. x\n   ```\n   3. y",
];
it("probe", () => {
  for (const md of cases) {
    const p = save(md, true), h = save(md);
    const pc = codes(md, true), hc = codes(md);
    log("r1.txt", "=== " + JSON.stringify(md) + "\nPARENT: " + JSON.stringify(p) + " codes " + JSON.stringify(pc) + "\nHEAD:   " + JSON.stringify(h) + " codes " + JSON.stringify(hc) + "\nHEAD2:  " + JSON.stringify(save(h)) + (save(h) === h ? " (stable)" : " UNSTABLE"));
  }
});
