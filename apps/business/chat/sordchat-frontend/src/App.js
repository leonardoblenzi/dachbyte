import React, { useEffect } from "react";
import {
  BrowserRouter,
  HashRouter,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { WebSocketProvider } from "./contexts/WebSocketContext";
import { PlatformDialogProvider } from "./contexts/PlatformDialogContext";
import Layout from "./components/layout/Layout";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import ChangePassword from "./pages/ChangePassword";
import Dashboard from "./pages/Dashboard";
import Chat from "./pages/Chat";
import Meetings from "./pages/Meetings";
import Kanban from "./pages/Kanban";
import Tickets from "./pages/Tickets";
import TicketReports from "./pages/TicketReports";
import Files from "./pages/Files";
import Users from "./pages/Users";
import Birthdays from "./pages/Birthdays";
import Notifications from "./pages/Notifications";
import Assistant from "./pages/Assistant";
import AdminPanel from "./pages/AdminPanel";
import CompanyAdminPanel from "./pages/CompanyAdminPanel";
import CoordinatorPanel from "./pages/CoordinatorPanel";
import Loading from "./components/common/Loading";
import Toast from "./components/common/Toast";
import VersionUpdatePrompt from "./components/common/VersionUpdatePrompt";
import BirthdayCelebration from "./components/common/BirthdayCelebration";
import DesktopTitleBar from "./components/common/DesktopTitleBar";
import VoiceCallOverlay from "./components/common/VoiceCallOverlay";

const ProtectedRoute = ({ children, allowPasswordChange = false }) => {
  const { isAuthenticated, loading, user } = useAuth();

  if (loading) {
    return <Loading fullScreen text="Verificando sessao..." />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user?.must_change_password && !allowPasswordChange) {
    return <Navigate to="/change-password" replace />;
  }

  return children;
};

const PublicRoute = ({ children }) => {
  const { isAuthenticated, loading, user } = useAuth();

  if (loading) {
    return <Loading fullScreen text="Verificando sessao..." />;
  }

  if (!isAuthenticated) {
    return children;
  }

  return (
    <Navigate
      to={user?.must_change_password ? "/change-password" : "/dashboard"}
      replace
    />
  );
};


const ProtectedApp = () => (
  <WebSocketProvider>
    <Layout>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/meetings" element={<Meetings />} />
        <Route path="/tickets" element={<Tickets />} />
        <Route path="/ticket-reports" element={<TicketReports />} />
        <Route path="/tasks" element={<Kanban />} />
        <Route path="/kanban" element={<Kanban />} />
        <Route path="/files" element={<Files />} />
        <Route path="/users" element={<Users />} />
        <Route path="/birthdays" element={<Birthdays />} />
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/admin" element={<AdminPanel />} />
        <Route path="/company-admin" element={<CompanyAdminPanel />} />
        <Route path="/coordinator" element={<CoordinatorPanel />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
    <VoiceCallOverlay />
  </WebSocketProvider>
);

function App() {
  const Router =
    window.location.protocol === "file:" ? HashRouter : BrowserRouter;
  const configuredPublicUrl =
    !process.env.PUBLIC_URL || process.env.PUBLIC_URL === "."
      ? undefined
      : process.env.PUBLIC_URL.replace(/\/+$/, "");
  const browserPath = window.location.pathname || "/";
  const routerBaseName =
    window.location.protocol === "file:"
      ? undefined
      : browserPath === "/chat" || browserPath.startsWith("/chat/")
        ? "/chat"
        : browserPath === "/business/chat" || browserPath.startsWith("/business/chat/")
          ? "/business/chat"
          : configuredPublicUrl;

  useEffect(() => {
    const themeMode = localStorage.getItem("voltchat:themeMode") || "light";
    const chatFontSize = localStorage.getItem("voltchat:chatFontSize") || "medium";
    document.documentElement.classList.toggle(
      "theme-dark",
      themeMode === "dark",
    );
    const fontSizeValue =
      chatFontSize === "small"
        ? "13px"
        : chatFontSize === "large"
        ? "17px"
        : "15px";
    document.documentElement.style.setProperty("--chat-font-size", fontSizeValue);
  }, []);

  const isDesktop = Boolean(
    window.voltChatDesktop && window.voltChatDesktop.customTitleBar !== false,
  );

  return (
    <div className={isDesktop ? "desktop-app-shell" : undefined}>
      {isDesktop && <DesktopTitleBar />}
      <div className={isDesktop ? "desktop-app-content" : undefined}>
        <AuthProvider>
          <PlatformDialogProvider>
            <Router basename={routerBaseName}>
            <Toast />
            <VersionUpdatePrompt />
            <BirthdayCelebration />
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route
                path="/login"
                element={
                  <PublicRoute>
                    <Login />
                  </PublicRoute>
                }
              />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route
                path="/change-password"
                element={
                  <ProtectedRoute allowPasswordChange>
                    <ChangePassword />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/*"
                element={
                  <ProtectedRoute>
                    <ProtectedApp />
                  </ProtectedRoute>
                }
              />
            </Routes>
            </Router>
          </PlatformDialogProvider>
        </AuthProvider>
      </div>
    </div>
  );
}

export default App;
