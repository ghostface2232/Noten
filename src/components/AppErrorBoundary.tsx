import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { Button, FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { detectSystemLocale, t } from "../i18n";
import { logNotenError } from "../utils/crashLog";
import { NotenError } from "../utils/notenError";

class RenderGuard extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
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
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const SCREEN: CSSProperties = {
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  padding: 32,
  boxSizing: "border-box",
  textAlign: "center",
};
const MESSAGE: CSSProperties = { margin: 0, maxWidth: 480 };
const ACTIONS: CSSProperties = { display: "flex", gap: 8 };

const reload = () => location.reload();
// The window has no frame of its own, and the title bar is gone with the app.
const closeWindow = () => void getCurrentWindow().close();

/** Its own provider, since the settings that choose the app's theme may be what failed. */
function CrashScreen() {
  const locale = detectSystemLocale();
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return (
    <FluentProvider theme={dark ? webDarkTheme : webLightTheme}>
      <div role="alert" style={SCREEN}>
        <p style={MESSAGE}>{t("error.appCrashed", locale)}</p>
        <div style={ACTIONS}>
          <Button appearance="primary" className="noten-filled-button" onClick={reload}>{t("error.reload", locale)}</Button>
          <Button onClick={closeWindow}>{t("error.closeWindow", locale)}</Button>
        </div>
      </div>
    </FluentProvider>
  );
}

/** Only for when Fluent itself is what failed: an empty window is worse than plain controls. */
function PlainCrashScreen() {
  const locale = detectSystemLocale();
  return (
    <div role="alert" style={{ ...SCREEN, background: "Canvas", color: "CanvasText", font: "14px system-ui, sans-serif" }}>
      <p style={MESSAGE}>{t("error.appCrashed", locale)}</p>
      <div style={ACTIONS}>
        <button type="button" onClick={reload}>{t("error.reload", locale)}</button>
        <button type="button" onClick={closeWindow}>{t("error.closeWindow", locale)}</button>
      </div>
    </div>
  );
}

/**
 * Without a boundary, an error thrown while rendering unmounts the whole app and
 * leaves an empty window.
 */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <RenderGuard
      fallback={(
        <RenderGuard fallback={<PlainCrashScreen />}>
          <CrashScreen />
        </RenderGuard>
      )}
    >
      {children}
    </RenderGuard>
  );
}
