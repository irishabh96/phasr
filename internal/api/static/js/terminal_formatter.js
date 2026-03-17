// (function (root, factory) {
//   const api = factory();
//   if (typeof module === "object" && module.exports) {
//     module.exports = api;
//   }
//   if (root) {
//     root.phasrTerminalFormatter = api;
//   }
// })(typeof globalThis !== "undefined" ? globalThis : this, function () {
//   const ANSI_SGR_RE = /\x1b\[([0-9;]*)m/g;
//   const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

//   function normalizeWidth(width) {
//     const value = Number(width) || 120;
//     if (value < 40) return 40;
//     if (value > 240) return 240;
//     return Math.floor(value);
//   }

//   function stripAnsi(value) {
//     return String(value || "").replace(ANSI_RE, "");
//   }

//   function visibleLength(value) {
//     return stripAnsi(value).length;
//   }

//   function hasBackgroundCode(params) {
//     if (!params) return false;
//     const codes = String(params)
//       .split(";")
//       .map((part) => Number.parseInt(part, 10))
//       .filter((part) => Number.isFinite(part));

//     for (let i = 0; i < codes.length; i += 1) {
//       const code = codes[i];
//       if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) || code === 49 || code === 48) {
//         return true;
//       }
//     }
//     return false;
//   }

//   function stripBackgroundAnsi(value) {
//     return String(value || "").replace(ANSI_SGR_RE, (match, params) => {
//       if (hasBackgroundCode(params)) return "";
//       return match;
//     });
//   }

//   function ensureAnsiReset(line) {
//     if (!line.includes("\x1b[")) return line;
//     if (/\x1b\[(?:0|)m/.test(line)) return line;
//     return line + "\x1b[0m";
//   }

//   function truncateMiddle(text, maxLength) {
//     const value = String(text || "");
//     if (maxLength <= 0) return "";
//     if (value.length <= maxLength) return value;
//     if (maxLength <= 3) return ".".repeat(maxLength);
//     const keep = maxLength - 3;
//     const left = Math.ceil(keep / 2);
//     const right = Math.floor(keep / 2);
//     return value.slice(0, left) + "..." + value.slice(value.length - right);
//   }

//   function splitLongToken(token, maxWidth) {
//     const value = String(token || "");
//     if (!value) return [];
//     if (value.length <= maxWidth) return [value];

//     const out = [];
//     let rest = value;

//     while (rest.length > maxWidth) {
//       let cut = -1;
//       const separators = ["/", "\\", "-", "_", "."];
//       for (const sep of separators) {
//         const candidate = rest.lastIndexOf(sep, maxWidth - 1);
//         if (candidate > cut) {
//           cut = candidate;
//         }
//       }

//       if (cut < Math.floor(maxWidth / 2)) {
//         cut = maxWidth;
//       } else {
//         cut += 1;
//       }

//       out.push(rest.slice(0, cut));
//       rest = rest.slice(cut);
//     }

//     if (rest) out.push(rest);
//     return out;
//   }

//   function wrapWithHangingIndent(text, width, firstIndent, hangingIndent) {
//     const initial = String(firstIndent || "");
//     const hanging = String(hangingIndent || "");
//     const source = String(text || "").trim();

//     if (!source) return [initial.trimEnd()];

//     const firstBudget = Math.max(8, width - visibleLength(initial));
//     const hangingBudget = Math.max(8, width - visibleLength(hanging));

//     const tokens = source
//       .split(/\s+/)
//       .flatMap((token) => splitLongToken(token, Math.max(8, Math.min(firstBudget, hangingBudget))));

//     const rawLines = [];
//     let current = "";

//     for (const token of tokens) {
//       const budget = rawLines.length === 0 ? firstBudget : hangingBudget;
//       if (!current) {
//         current = token;
//         continue;
//       }

//       if ((current.length + 1 + token.length) <= budget) {
//         current += " " + token;
//       } else {
//         rawLines.push(current);
//         current = token;
//       }
//     }

//     if (current) rawLines.push(current);

//     return rawLines.map((line, idx) => (idx === 0 ? initial : hanging) + line);
//   }

//   function extractPathMetadata(text) {
//     const value = String(text || "");

//     const fileMatch = value.match(/\((?:file|path):\s*([^\)]+)\)\s*$/i);
//     if (fileMatch) {
//       const path = fileMatch[1].trim();
//       const content = value.slice(0, fileMatch.index).trimEnd();
//       return { content, path };
//     }

//     const inlineMatch = value.match(/(?:^|\s)(?:file|path):\s*(\/\S+)\s*$/i);
//     if (inlineMatch) {
//       const path = inlineMatch[1].trim();
//       const content = value.slice(0, inlineMatch.index).trimEnd();
//       return { content, path };
//     }

//     return { content: value, path: "" };
//   }

//   function formatStructuredLine(line, width) {
//     const value = String(line || "").trimEnd();
//     const bullet = value.match(/^(\s*(?:[-*]|\d+\.)\s+)(.*)$/);

//     if (bullet) {
//       const prefix = bullet[1];
//       const nestedIndent = " ".repeat(Math.max(2, visibleLength(prefix)));
//       const metadata = extractPathMetadata(bullet[2]);

//       const out = wrapWithHangingIndent(metadata.content, width, prefix, nestedIndent);
//       if (metadata.path) {
//         const pathPrefix = nestedIndent + "path: ";
//         const pathMax = Math.max(12, width - visibleLength(pathPrefix));
//         const renderedPath = metadata.path.length > pathMax
//           ? truncateMiddle(metadata.path, pathMax)
//           : metadata.path;
//         out.push(pathPrefix + renderedPath);
//       }
//       return out.join("\n");
//     }

//     const metadata = extractPathMetadata(value);
//     if (!metadata.path) return value;

//     const out = wrapWithHangingIndent(metadata.content, width, "", "  ");
//     const pathPrefix = "  path: ";
//     const pathMax = Math.max(12, width - visibleLength(pathPrefix));
//     const renderedPath = metadata.path.length > pathMax
//       ? truncateMiddle(metadata.path, pathMax)
//       : metadata.path;
//     out.push(pathPrefix + renderedPath);
//     return out.join("\n");
//   }

//   function isStructuredLine(line) {
//     const value = String(line || "").trim();
//     if (!value) return false;
//     if (/^(\s*(?:[-*]|\d+\.)\s+)/.test(value)) return true;
//     if (/^#{1,6}\s+/.test(value)) return true;
//     if (/skills?/i.test(value) && /:/.test(value)) return true;
//     if (/\((?:file|path):\s*[^\)]+\)\s*$/i.test(value)) return true;
//     return false;
//   }

//   function shouldWrapParagraph(line, width) {
//     const value = String(line || "").trimEnd();
//     if (visibleLength(value) <= width) return false;
//     if (!/\s/.test(value)) return false;
//     if (/\t/.test(value)) return false;
//     if (/^\s*```/.test(value) || /^\s*`/.test(value)) return false;
//     if (/^\s*[$>#]/.test(value)) return false;
//     if (/[{};]/.test(value) && !/skills?|path/i.test(value)) return false;
//     return true;
//   }

//   function formatLine(line, width) {
//     const cleanLine = String(line || "").trimEnd();
//     if (!cleanLine) return "";
//     if (cleanLine.includes("\x1b[")) return ensureAnsiReset(cleanLine);

//     if (isStructuredLine(cleanLine)) {
//       return formatStructuredLine(cleanLine, width);
//     }

//     if (shouldWrapParagraph(cleanLine, width)) {
//       return wrapWithHangingIndent(cleanLine, width, "", "  ").join("\n");
//     }

//     return cleanLine;
//   }

//   function formatChunk(chunk, columns) {
//     const width = normalizeWidth(columns);
//     const sanitized = stripBackgroundAnsi(String(chunk || ""));

//     // Carriage-return driven updates (progress bars, live redraws) should pass through untouched.
//     if (sanitized.includes("\r")) return sanitized;

//     return sanitized
//       .split("\n")
//       .map((line) => formatLine(line, width))
//       .join("\n");
//   }

//   function createFormatter() {
//     return {
//       reset() {},
//       format(chunk, columns) {
//         return formatChunk(chunk, columns);
//       },
//     };
//   }

//   return {
//     createFormatter,
//     formatChunk,
//     formatStructuredLine,
//     stripBackgroundAnsi,
//     truncateMiddle,
//     wrapWithHangingIndent,
//   };
// });
