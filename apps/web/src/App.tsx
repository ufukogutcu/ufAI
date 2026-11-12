import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  Home as HomeIcon,
  Palette,
  Settings,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import { DashboardProvider } from "./components/DashboardProvider";
import { Tooltip } from "./components/Tooltip";
import { RelaySymbol } from "./components/RelaySymbol";
import { GlassMaterial } from "./components/GlassMaterial";
import {
  createSettingsStore,
  SettingsContext,
  useSettings,
} from "./settings-store";
import { UnsavedChangesProvider } from "./components/UnsavedChanges";
import { useNavigationGuard } from "./navigation-guard";
import { ThemeProvider } from "./components/ThemeProvider";
import type { SettingsResponse } from "../../server/src/contracts";
import Themes from "./pages/Themes";
import Home from "./pages/Home";
import Providers from "./pages/Providers";
import { ConnectionContext, createConnectionStore } from "./connection-store";
import Presets from "./pages/Presets";
import styles from "./App.module.scss";

const pages = [
  { id: "home", label: "Home", icon: HomeIcon },
  { id: "providers", label: "Providers", icon: Server },
  { id: "agent-presets", label: "Agent Presets", icon: SlidersHorizontal },
  { id: "theme", label: "Theme", icon: Palette },
  { id: "settings", label: "Settings", icon: Settings },
] as const;
type PageId = (typeof pages)[number]["id"];
function readPage(): PageId {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "model-presets") return "agent-presets";
  return pages.find((page) => page.id === hash)?.id ?? "home";
}

function Shell() {
  const [page, setPage] = useState(readPage);
  const settingsError = useSettings((state) => state.error);
  const retrySettings = useSettings((state) => state.retry);
  const attempt = useNavigationGuard();
  const pageRef = useRef(page);
  const historyIndex = useRef<number>(window.history.state?.ufaiIndex ?? 0);
  const restoringHistory = useRef(false);
  useEffect(() => {
    window.history.replaceState(
      { ufaiIndex: historyIndex.current },
      "",
      `#/${pageRef.current}`,
    );
    function handleHistoryChange() {
      if (restoringHistory.current) {
        restoringHistory.current = false;
        return;
      }
      const target = readPage();
      if (target === pageRef.current) return;
      const storedIndex = window.history.state?.ufaiIndex;
      const targetIndex =
        Number.isInteger(storedIndex) && storedIndex !== historyIndex.current
          ? (storedIndex as number)
          : historyIndex.current + 1;
      const delta = targetIndex - historyIndex.current;
      window.history.replaceState(
        { ufaiIndex: targetIndex },
        "",
        `#/${target}`,
      );
      let blocked = false;
      const accepted = attempt(() => {
        if (blocked) {
          // Re-enter the original history entry after the user confirms.
          window.history.go(delta);
          return;
        }
        historyIndex.current = targetIndex;
        pageRef.current = target;
        setPage(target);
      });
      if (!accepted) {
        blocked = true;
        restoringHistory.current = true;
        window.history.go(-delta);
      }
    }
    function handleHashChange() {
      // popstate precedes hashchange during browser history traversal.
      if (!restoringHistory.current && readPage() !== pageRef.current)
        handleHistoryChange();
    }
    window.addEventListener("popstate", handleHistoryChange);
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("popstate", handleHistoryChange);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, [attempt]);
  function navigate(event: MouseEvent<HTMLAnchorElement>, target: PageId) {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    if (target === page) return;
    attempt(() => {
      historyIndex.current += 1;
      window.history.pushState(
        { ufaiIndex: historyIndex.current },
        "",
        `#/${target}`,
      );
      pageRef.current = target;
      setPage(target);
    });
  }
  const current = pages.find((item) => item.id === page)!;
  return (
    <div className={styles.app}>
      <a
        className="skipLink"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <a
        href="https://github.com/ufukogutcu/ufAI"
        className={styles.brand}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="ufAI GitHub repository (opens in a new tab)"
      >
        <RelaySymbol />
      </a>
      <nav
        aria-label="Main navigation"
        className={`${styles.dock} glassSurface`}
      >
        <GlassMaterial />
        <span
          className={styles.selection}
          aria-hidden="true"
          style={
            {
              "--nav-index": pages.findIndex((item) => item.id === page),
            } as CSSProperties
          }
        />
        {pages.map((item) => (
          <Tooltip key={item.id} content={item.label} placement="right">
            <a
              href={`#/${item.id}`}
              className={`${styles.navItem} ${page === item.id ? styles.active : ""}`}
              aria-label={item.label}
              aria-current={page === item.id ? "page" : undefined}
              onClick={(event) => navigate(event, item.id)}
            >
              <item.icon size={18} strokeWidth={1.65} aria-hidden="true" />
            </a>
          </Tooltip>
        ))}
      </nav>
      <div className={styles.mainColumn}>
        <main id="main-content" tabIndex={-1} className={styles.main}>
          {settingsError && (
            <div className="errorBanner" role="alert">
              {settingsError}{" "}
              <button
                className="textButton"
                onClick={() => void retrySettings()}
              >
                Retry
              </button>
            </div>
          )}
          {page === "home" ? (
            <Home />
          ) : page === "agent-presets" ? (
            <Presets />
          ) : page === "providers" ? (
            <Providers />
          ) : page === "theme" ? (
            <Themes />
          ) : (
            <section className={styles.placeholder}>
              <header className="pageHeader">
                <div>
                  <h1>{current.label}</h1>
                </div>
              </header>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
export default function App({ initial }: { initial: SettingsResponse }) {
  const [connections] = useState(createConnectionStore);
  const [settings] = useState(() => createSettingsStore(initial));
  return (
    <SettingsContext.Provider value={settings}>
      <ThemeProvider>
        <ConnectionContext.Provider value={connections}>
          <DashboardProvider>
            <UnsavedChangesProvider>
              <Shell />
            </UnsavedChangesProvider>
          </DashboardProvider>
        </ConnectionContext.Provider>
      </ThemeProvider>
    </SettingsContext.Provider>
  );
}
