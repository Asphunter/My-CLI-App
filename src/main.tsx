import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// A KaTeX a saját betűit hozza; előbb tölt, hogy a mi szabályaink nyerjenek.
import "katex/dist/katex.min.css";
import "../styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
