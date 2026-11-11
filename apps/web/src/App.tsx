import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  ChevronRight,
  Home as HomeIcon,
  Laptop,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  Settings,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { DashboardProvider } from "./components/DashboardProvider";
import { Tooltip } from "./components/Tooltip";
import { readPreference, writePreference } from "./api";
import { UnsavedChangesProvider } from "./components/UnsavedChanges";
import { useNavigationGuard } from "./navigation-guard";
import Home from "./pages/Home";
import Presets from "./pages/Presets";
import styles from "./App.module.scss";

const pages = [
  { id: "home", label: "Home", icon: HomeIcon },
  { id: "model-presets", label: "Model Presets", icon: SlidersHorizontal },
  { id: "theme", label: "Theme", icon: Palette },
  { id: "settings", label: "Settings", icon: Settings },
] as const;
type PageId = (typeof pages)[number]["id"];
function readPage(): PageId {
  const hash = window.location.hash.replace(/^#\/?/, "");
  return pages.find((page) => page.id === hash)?.id ?? "home";
}

function Shell() {
  const [page, setPage] = useState(readPage);
  const [expanded, setExpanded] = useState(
    () => readPreference("sidebar") === "expanded",
  );
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
  function handleToggle() {
    setExpanded((current) => {
      writePreference("sidebar", current ? "collapsed" : "expanded");
      return !current;
    });
  }
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
    function closeMobileSidebar() {
      if (window.matchMedia("(max-width: 540px)").matches) setExpanded(false);
    }
    if (target === page) {
      closeMobileSidebar();
      return;
    }
    attempt(() => {
      historyIndex.current += 1;
      window.history.pushState(
        { ufaiIndex: historyIndex.current },
        "",
        `#/${target}`,
      );
      pageRef.current = target;
      setPage(target);
      closeMobileSidebar();
    });
  }
  const current = pages.find((item) => item.id === page)!;
  return (
    <div className={`${styles.app} ${expanded ? styles.expanded : ""}`}>
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
      <aside className={styles.sidebar} aria-label="Application sidebar">
        <a
          href="#/home"
          className={styles.brand}
          aria-label="ufAI Home"
          onClick={(event) => navigate(event, "home")}
        >
          <span className={styles.logo}>
            u<span>f</span>
          </span>
          {expanded && (
            <span className={styles.wordmark}>
              ufAI<span>AGENT WORKSPACE</span>
            </span>
          )}
        </a>
        <div className={styles.navHeading}>
          {expanded ? "WORKSPACE" : <span />}
        </div>
        <nav aria-label="Main navigation" className={styles.nav}>
          {pages.map((item) => (
            <Tooltip
              key={item.id}
              content={expanded ? "" : item.label}
              placement="right"
            >
              <a
                href={`#/${item.id}`}
                className={`${styles.navItem} ${page === item.id ? styles.active : ""}`}
                aria-label={item.label}
                aria-current={page === item.id ? "page" : undefined}
                onClick={(event) => navigate(event, item.id)}
              >
                <item.icon size={19} strokeWidth={1.65} />
                {expanded && <span>{item.label}</span>}
                {page === item.id && expanded && <ChevronRight size={13} />}
              </a>
            </Tooltip>
          ))}
        </nav>
        <div className={styles.sidebarBottom}>
          <Tooltip content="Local instance" placement="right">
            <div className={styles.localInstance}>
              <span className={styles.instanceIcon}>
                <Laptop size={17} />
              </span>
              {expanded && (
                <span>
                  Local instance<small>On your machine</small>
                </span>
              )}
            </div>
          </Tooltip>
          <Tooltip
            content={expanded ? "Collapse sidebar" : "Expand sidebar"}
            placement="right"
          >
            <button
              className={styles.collapse}
              type="button"
              onClick={handleToggle}
              aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
              aria-expanded={expanded}
            >
              {expanded ? (
                <PanelLeftClose size={17} />
              ) : (
                <PanelLeftOpen size={17} />
              )}
              {expanded && <span>Collapse sidebar</span>}
            </button>
          </Tooltip>
        </div>
      </aside>
      {expanded && (
        <button
          className={styles.sidebarBackdrop}
          aria-label="Close navigation"
          onClick={handleToggle}
        />
      )}
      <div className={styles.mainColumn}>
        <div className={styles.topbar}>
          <div className={styles.breadcrumb}>
            <span>ufAI</span>
            <ChevronRight size={12} />
            <span>{current.label}</span>
          </div>
          <div className={styles.topbarRight}>
            <span className={styles.projectTag}>
              <Sparkles size={12} />
              Your space to build
            </span>
            <span className={styles.localFirst}>LOCAL FIRST</span>
          </div>
        </div>
        <main id="main-content" tabIndex={-1} className={styles.main}>
          {page === "home" ? (
            <Home />
          ) : page === "model-presets" ? (
            <Presets />
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
        <footer className={styles.statusbar}>
          <span>
            <span className={styles.statusDot} />
            ufAI<span className={styles.statusDivider}>/</span>Local agent
            workspace
          </span>
          <span>Made for the way you work.</span>
        </footer>
      </div>
    </div>
  );
}
export default function App() {
  return (
    <DashboardProvider>
      <UnsavedChangesProvider>
        <Shell />
      </UnsavedChangesProvider>
    </DashboardProvider>
  );
}
