import { WindowControls } from "./WindowControls";
import "./FirstRunWindowChrome.css";

/** Invisible drag strip plus the single close button for first-run screens. */
export function FirstRunWindowChrome() {
  return (
    <div className="sh-first-run-window-chrome" role="presentation">
      <div className="sh-first-run-window-chrome__drag" data-tauri-drag-region />
      <WindowControls variant="close-only" />
    </div>
  );
}
