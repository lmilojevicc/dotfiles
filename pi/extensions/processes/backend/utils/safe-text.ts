// Streaming terminal-control parser: never retain an unbounded escape sequence.
export class SafeText {
  state: 'text'|'escape'|'csi'|'string'|'string-escape' = 'text';
  osc = false;
  push(text: string): string {
    let result = '';
    for (const c of text) {
      const n = c.codePointAt(0)!;
      if (this.state === 'string-escape') {
        this.state = c === '\\' || n === 0x9c ? 'text' : 'string';
        continue;
      }
      if (this.state === 'string') {
        if (c === '\x1b') this.state = 'string-escape';
        else if ((this.osc && n === 7) || n === 0x9c) this.state = 'text';
        continue;
      }
      if (this.state === 'csi') {
        if (n >= 0x40 && n <= 0x7e) this.state = 'text';
        else if (n === 0x1b) this.state = 'escape';
        continue;
      }
      if (this.state === 'escape') {
        if (c === '[') this.state = 'csi';
        else if (']PX^_'.includes(c)) { this.state = 'string'; this.osc = c === ']'; }
        else if (n < 0x20 || n > 0x2f) this.state = 'text';
        continue;
      }
      if (n === 0x1b) this.state = 'escape';
      else if (n === 0x9b) this.state = 'csi';
      else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(n)) { this.state = 'string'; this.osc = n === 0x9d; }
      else if (c === '\n' || c === '\t' || (n >= 0x20 && !(n >= 0x7f && n <= 0x9f) && !/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u.test(c))) result += c;
    }
    return result;
  }
}
export const safe = (s: string): string => new SafeText().push(s);
