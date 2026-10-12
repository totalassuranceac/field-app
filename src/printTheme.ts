/** Print in LIGHT theme no matter what the screen theme is. Restores after print. */
export async function printWithLightTheme(bodyClass: string): Promise<void> {
  const root = document.documentElement;
  const prevTheme = root.getAttribute("data-theme");
  const prevScheme = root.style.colorScheme;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (prevTheme) root.setAttribute("data-theme", prevTheme);
    else root.removeAttribute("data-theme");
    root.style.colorScheme = prevScheme;
    document.body.classList.remove(bodyClass);
    window.removeEventListener("afterprint", restore);
  };
  root.setAttribute("data-theme", "light");
  root.style.colorScheme = "light";
  document.body.classList.add(bodyClass);
  window.addEventListener("afterprint", restore);
  window.setTimeout(restore, 120000); // safety: iOS sometimes never fires afterprint
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  window.print();
}
