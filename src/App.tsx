import { useState } from 'react';
import './App.css';
import MessagesView from './components/MessagesView';
import AnalyticsView from './components/AnalyticsView';
import BillsView from './components/BillsView';

export default function App() {
  const [activeTab, setActiveTab] = useState<'messages' | 'analytics' | 'bills'>('messages');

  return (
    <div className="app">
      {/* Header with Tab Navigation */}
      <div className="app-header">
        <div className="app-title">📢 Push Notification Dashboard</div>
        <nav className="tab-nav">
          <button
            className={`tab-button ${activeTab === 'messages' ? 'active' : ''}`}
            onClick={() => setActiveTab('messages')}
          >
            Messages
          </button>
          <button
            className={`tab-button ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            Analytics
          </button>
          <button
            className={`tab-button ${activeTab === 'bills' ? 'active' : ''}`}
            onClick={() => setActiveTab('bills')}
          >
            Billing
          </button>
        </nav>
      </div>

      {/* Main Content Area */}
      <div className="app-content">
        <div className="view-container">
          {activeTab === 'messages' && <MessagesView />}
          {activeTab === 'analytics' && <AnalyticsView />}
          {activeTab === 'bills' && <BillsView />}
        </div>
      </div>
    </div>
  );
}
