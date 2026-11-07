// Shared drag-to-resize for the left and right panels.
// `direction` is +1 when dragging right makes the panel wider (left panel), -1 for the right panel.
window.makeResizeHandle = function makeResizeHandle(handle, { get, set, direction, reset }) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = get();
    document.body.classList.add("resizing");
    handle.classList.add("dragging");
    const move = (e) => set(startWidth + direction * (e.clientX - startX), false);
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing");
      handle.classList.remove("dragging");
      set(get(), true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  handle.addEventListener("dblclick", () => reset());
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const sign = event.key === "ArrowRight" ? 1 : -1;
      set(get() + sign * direction * step, true);
    } else if (event.key === "Enter" || event.key === "Home") {
      event.preventDefault();
      reset();
    }
  });
};
