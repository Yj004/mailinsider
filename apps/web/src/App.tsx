import { Navigate, Route, Routes } from "react-router-dom"
import { useAuth } from "./auth"
import { Shell } from "./components/Shell"
import { ForgotPage, LoginPage, ResetPage, SignupPage } from "./pages/AuthPages"
import { AiPrPage } from "./pages/AiPrPage"
import { ComposePage } from "./pages/ComposePage"
import { DocumentsPage } from "./pages/DocumentsPage"
import { UnavailablePage } from "./components/layout/UnavailablePage"
import { CampaignsPage } from "./pages/CampaignsPage"
import { ContactsPage } from "./pages/ContactsPage"
import { LabelsPage } from "./pages/LabelsPage"
import { FollowUpsPage } from "./pages/FollowUpsPage"
import { MailPage } from "./pages/MailPage"
import { MessageDetailPage } from "./pages/MessageDetailPage"
import { MessagesPage } from "./pages/MessagesPage"
import { InsightsPage } from "./pages/InsightsPage"
import { AuditPage, IntegrationsPage, SettingsPage, TeamPage } from "./pages/SettingsPages"
import { TemplatesPage } from "./pages/TemplatesPage"
import { ViewerPage } from "./pages/ViewerPage"
import { PublicLayout } from "./pages/public/PublicLayout"
import { HomePage } from "./pages/public/HomePage"
import { PricingPage } from "./pages/public/PricingPage"
import { ContactPage } from "./pages/public/ContactPage"
import { FeaturesPage } from "./pages/public/FeaturesPage"
import { ProductVideoPage } from "./pages/public/ProductVideoPage"

export function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/features" element={<FeaturesPage />} />
      </Route>
      <Route path="/product-video" element={<ProductVideoPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route path="/reset" element={<ResetPage />} />
      <Route path="/view/:token" element={<ViewerPage />} />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="mail" replace />} />
        <Route path="mail" element={<MailPage />} />
        <Route path="mail/:id" element={<MessageDetailPage />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="messages/:id" element={<MessageDetailPage />} />
        <Route path="labels" element={<LabelsPage />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="follow-ups" element={<FollowUpsPage />} />
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route
          path="scheduling"
          element={
            <UnavailablePage
              title="Scheduling"
              body="Scheduling a future send is not available yet. Compose sends when you confirm."
              to="/app/compose"
              action="Compose a message"
            />
          }
        />
        <Route
          path="links"
          element={
            <UnavailablePage
              title="Link tracking"
              body="Tracked links are created when link tracking is on for a send. Open a message to see each request."
              to="/app/mail"
              action="Open mail"
            />
          }
        />
        <Route path="compose" element={<ComposePage />} />
        <Route path="ai-pr" element={<AiPrPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="insights" element={<InsightsPage />} />
        <Route path="analytics" element={<Navigate to="/app/insights" replace />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { ready, user } = useAuth()
  if (!ready) return <div className="loading">Opening your workspace…</div>
  if (!user) return <Navigate to="/login" replace />
  return children
}
