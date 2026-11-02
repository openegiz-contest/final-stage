// What the Judge read, as the monitor shows it: an activity item's `content`.
//
//   content: null                          pending: the call has no result yet
//   content: { text?, truncated?, image?, error? } the result: `text` is the first 4000 characters of what the
//                                          scrubbed log holds (`truncated` says whether more was cut),
//                                          `image` is the Stage's <img src> for a picture the Judge looked at:
//                                          a /pub/ URL when its path lies inside the Final Materials (always
//                                          the case for the Final's view_image), else a data: URL built from the
//                                          result's own image block (at most IMAGE_DATA_MAX base64 characters),
//                                          `error: true` for a refused or failed call (`text` is the refusal)
//   content: {}                            a result with nothing to show (empty, or a shape not understood)
//
// The director never fetches a file: the text is the log's, the image is only a URL for the Stage's <img>.

export const TEXT_MAX = 4000;
// The largest image block turned into a data: URL (base64 characters, about 750 KB of picture). Real
// Final screenshots are 40-60 KB base64; a bigger block is dropped, never cut.
export const IMAGE_DATA_MAX = 1_000_000;

// Keep the first `max` UTF-16 units, never cutting a surrogate pair in half.
function cut(text, max) {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// `path` as a path inside the Final Materials ("publication/solutions/team-003/screenshots/opus/01.png"),
// or null when it leaves them. The Final's tools take paths relative to the Materials root, so a relative
// path counts from there; an absolute one only if it lies under one of `roots`. The Stage serves the
// Materials folder as /pub/ (server.py --pub <run>/materials), so the path is the URL.
export function publicationPath(path, roots = []) {
  if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) return null;
  let p = path.trim();
  if (p.startsWith("/")) {
    const root = asList(roots).map((r) => String(r).replace(/\/+$/, "")).find((r) => r && (p === r || p.startsWith(r + "/")));
    if (!root) return null;
    p = p.slice(root.length);
  } else if (p.startsWith("~") || /^[a-z]+:/i.test(p)) {
    return null;
  }
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join("/") : null;
}

export function pubUrl(path, roots = []) {
  const rel = publicationPath(path, roots);
  return rel ? "/pub/" + rel.split("/").map(encodeURIComponent).join("/") : null;
}

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// An image block { mime, data } -> a data: URL, or null when it is not a plain base64 picture or too big.
export function dataUrl(image) {
  if (!image || typeof image.data !== "string" || !IMAGE_MIME.test(image.mime ?? "")) return null;
  if (image.data.length === 0 || image.data.length > IMAGE_DATA_MAX || !BASE64.test(image.data)) return null;
  return `data:${image.mime};base64,${image.data}`;
}

// A result ({text, image: {mime, data}|null, error} from activity.resultsFrom) of an activity item
// ({kind, path}) -> content
export function contentOf(result, item, { pubRoot = null } = {}) {
  const content = {};
  let text = typeof result?.text === "string" ? result.text : "";
  // an image file read through a shell command comes back as bytes, not as text
  if (item?.kind === "image" && /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(text)) text = "";
  if (text !== "") Object.assign(content, cut(text, TEXT_MAX));
  if (result?.error) content.error = true;
  else if (item?.kind === "image") {
    const image = pubUrl(item.path, pubRoot) ?? dataUrl(result?.image);
    if (image) content.image = image;
  }
  return content;
}
