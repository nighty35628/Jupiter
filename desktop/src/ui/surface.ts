export function hasNativeWindow(): boolean {
  return (
    document.documentElement.dataset.nativeWindow !== "false" &&
    document.documentElement.dataset.runtime !== "web"
  );
}
