/**
 * Put text on the clipboard. `navigator.clipboard` is missing on plain http
 * (an Umbrel on the LAN) and rejects when the page is not focused, so it falls
 * back to the selection trick. True only when something was really copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // refused: try the older way below
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
