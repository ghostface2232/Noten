import { Component, type ErrorInfo, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../i18n";
import { logNotenError } from "../utils/crashLog";
import { NotenError } from "../utils/notenError";

/**
 * Without a boundary, an error thrown while rendering unmounts the whole app and
 * leaves an empty window. This stays outside the Fluent provider and the settings,
 * since either may be what failed, so it reads the system's language and colours.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    void logNotenError(new NotenError(
      "UNCAUGHT",
      "fatal",
      error instanceof Error ? error.message : String(error),
      { context: { componentStack: info.componentStack ?? "" }, cause: error },
    ));
    // A window stays hidden until its note has loaded, which will not happen now.
    void getCurrentWindow().show().catch(() => {});
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const locale = navigator.language?.toLowerCase().startsWith("ko") ? "ko" : "en";
    return (
      <div
        role="alert"
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 32,
          boxSizing: "border-box",
          textAlign: "center",
          background: "Canvas",
          color: "CanvasText",
          font: "14px system-ui, sans-serif",
        }}
      >
        <p style={{ margin: 0, maxWidth: 480 }}>{t("error.appCrashed", locale)}</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={() => location.reload()}>{t("error.reload", locale)}</button>
          {/* The window has no frame of its own, and the title bar is gone with the app. */}
          <button type="button" onClick={() => void getCurrentWindow().close()}>{t("error.closeWindow", locale)}</button>
        </div>
      </div>
    );
  }
}
