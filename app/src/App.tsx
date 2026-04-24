import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { ProjectsList } from './pages/ProjectsList';
import { ProjectNew } from './pages/ProjectNew';
import { ProjectHome } from './pages/ProjectHome';
import { ProjectOverview } from './pages/ProjectOverview';
import { SubmittalList } from './pages/SubmittalList';
import { SubmittalDetail } from './pages/SubmittalDetail';
import { RFIList } from './pages/RFIList';
import { CloseoutDashboard } from './pages/CloseoutDashboard';
import { OwnerManualPage } from './pages/OwnerManual';
import { SettingsPage } from './pages/SettingsPage';
import { AutoReviewPage } from './pages/AutoReview';
import { ReviewQueuePage } from './pages/ReviewQueue';
import { BidLevelingPage } from './pages/BidLevelingPage';
import { PersonalOpsPage } from './pages/PersonalOpsPage';
import { ManagerDashboardPage } from './pages/ManagerDashboard';
import { CutsheetReviewPage } from './pages/CutsheetReview';
import { CutsheetRepositoryPage } from './pages/CutsheetRepository';
import { CutsheetMyUploadsPage } from './pages/CutsheetMyUploads';
import { EffortSurveyPage } from './pages/EffortSurvey';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { isSupabaseConfigured } from './lib/supabase';
import { useSupabaseSync } from './hooks/useSupabaseSync';

function ProtectedRoute() {
  const { session, loading } = useAuth();

  // Show spinner while auth is resolving
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange" />
      </div>
    );
  }

  // In demo mode (Supabase not configured), allow access
  if (!isSupabaseConfigured()) {
    return <Outlet />;
  }

  // If Supabase IS configured but no session, redirect to login
  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return <DataLoader />;
}

/**
 * Sits between auth confirmation and the child routes.
 * Fetches all Supabase data into the Zustand store before rendering.
 */
function DataLoader() {
  const { isLoading, isInitialized } = useSupabaseSync();

  if (isLoading || !isInitialized) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange" />
        <p className="text-sm text-gray-500">Loading project data…</p>
      </div>
    );
  }

  return <Outlet />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="projects" element={<ProjectsList />} />
              <Route path="projects/new" element={<ProjectNew />} />
              <Route path="projects/:projectId" element={<ProjectHome />}>
                <Route index element={<ProjectOverview />} />
                <Route path="review" element={<AutoReviewPage />} />
                <Route path="submittals" element={<SubmittalList />} />
                <Route path="submittals/:submittalId" element={<SubmittalDetail />} />
                <Route path="rfis" element={<RFIList />} />
                <Route path="closeout" element={<CloseoutDashboard />} />
                <Route path="manual" element={<OwnerManualPage />} />
                <Route path="bid-leveling" element={<BidLevelingPage />} />
                <Route path="pre-survey" element={<EffortSurveyPage kind="pre-sales" />} />
                <Route path="post-survey" element={<EffortSurveyPage kind="post-sales" />} />
              </Route>
              <Route path="review-queue" element={<ReviewQueuePage />} />
              <Route path="manager-dashboard" element={<ManagerDashboardPage />} />
              <Route path="cutsheet-review" element={<CutsheetReviewPage />} />
              <Route path="cutsheet-repository" element={<CutsheetRepositoryPage />} />
              <Route path="cutsheet-my-uploads" element={<CutsheetMyUploadsPage />} />
              <Route path="personal-ops" element={<PersonalOpsPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
