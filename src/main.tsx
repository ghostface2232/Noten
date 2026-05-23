import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initCrashLog } from "./utils/crashLog";
import "./styles/theme.css";

initCrashLog();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
