// Native macOS notifications via osascript.
export async function notifyMac(title: string, body: string) {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    await Bun.$`osascript -e ${`display notification "${esc(body.slice(0, 200))}" with title "${esc(title)}" sound name "Glass"`}`.quiet();
  } catch (err) {
    console.error("[notify:mac] failed:", err);
  }
}
