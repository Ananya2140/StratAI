import React, { useState, useEffect, useRef } from 'react';
import {
  AreaChart, Area,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis,
  CartesianGrid, Tooltip,
  ResponsiveContainer,
  Legend, Label
} from 'recharts';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [activeTab, setActiveTab] = useState('overview');

  const [summary, setSummary] = useState({ total_records: 0, numeric_aggregates: {}, all_columns: [], selected_kpis: [], column_types: {}, active_file: "None Loaded" });
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");

  // Predictive Forecast Engine -- linear-regression projection + AI measures
  // and suggestions computed from the SAME trend/breakdown columns shown in
  // the Analytics Dashboards tab, so the recommendations are grounded in
  // what the user is actually looking at.
  const [forecastData, setForecastData] = useState(null);

  // AI Boardroom Assistant chat state -- works against whatever dataset is
  // currently loaded, no hardcoded schema assumptions. The backend now runs
  // a live SQL query behind the scenes for precise questions, and returns
  // which query it used (if any) alongside the natural-language answer.
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  const [selectedColDropdown, setSelectedColDropdown] = useState("");
  const [customFormulaText, setCustomFormulaText] = useState("");
  const [customMeasureName, setCustomMeasureName] = useState("");
  const [customKpisList, setCustomKpisList] = useState([]);
  const [formulaEngineError, setFormulaEngineError] = useState("");

  const [autoInsights, setAutoInsights] = useState(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [tablePreviewRows, setTablePreviewRows] = useState([]);

  const refreshPlatformData = async () => {
    try {
      const resSum = await fetch('http://127.0.0.1:8000/api/analytics/summary');
      if (resSum.ok) {
        const data = await resSum.json();
        setSummary(data);
        if (data.all_columns && data.all_columns.length > 0 && !selectedColDropdown) {
          setSelectedColDropdown(data.all_columns[0]);
        }
      }

      const resChart = await fetch('http://127.0.0.1:8000/api/analytics/multichart');
      if (resChart.ok) setChartData(await resChart.json());

      const resInsights = await fetch('http://127.0.0.1:8000/api/analytics/dashboard_insights');
      if (resInsights.ok) {
        const insightsData = await resInsights.json();
        setAutoInsights(Object.keys(insightsData).length > 0 ? insightsData : null);
      }

      const resForecast = await fetch('http://127.0.0.1:8000/api/analytics/forecast');
      if (resForecast.ok) {
        const forecastResult = await resForecast.json();
        setForecastData(Object.keys(forecastResult).length > 0 ? forecastResult : null);
      }
    } catch (err) {
      console.error("Platform workspace sync error:", err);
    }
  };

  useEffect(() => { if (isAuthenticated) { refreshPlatformData(); } }, [isAuthenticated, activeTab]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, chatLoading]);

  const handleOpenFilePreview = async () => {
    if (summary.total_records === 0) return;
    try {
      const response = await fetch('http://127.0.0.1:8000/api/dataset/preview');
      if (response.ok) {
        setTablePreviewRows(await response.json());
        setShowPreviewModal(true);
      }
    } catch (err) {
      console.error("Preview data grid tracking error:", err);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      const res = await fetch('http://127.0.0.1:8000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (res.ok) {
        setIsAuthenticated(true);
      } else {
        setAuthError((await res.json()).detail || "Authorization trace validation breach.");
      }
    } catch (err) {
      setAuthError("Failed to reach core gateway listener port.");
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    setLoading(true);
    setUploadStatus("Ingesting file structure arrays...");
    try {
      const res = await fetch('http://127.0.0.1:8000/api/upload', { method: 'POST', body: formData });
      if (res.ok) {
        setUploadStatus("Ingestion complete. Layout fields mapped dynamically.");
        setSelectedColDropdown("");
        setChatMessages([]);
        await refreshPlatformData();
      } else {
        setUploadStatus("Upload aborted.");
      }
    } catch (err) {
      setUploadStatus("Network handshake loop disconnect.");
    } finally {
      setLoading(false);
    }
  };

  const handlePurgeDataset = async () => {
    if (!window.confirm("Confirm Action: Purge active data cache records completely from system storage?")) return;
    try {
      const res = await fetch('http://127.0.0.1:8000/api/dataset/purge', { method: 'DELETE' });
      if (res.ok) {
        setUploadStatus("Active datastore structures dropped. Workspace reset.");
        setCustomKpisList([]);
        setChartData([]);
        setAutoInsights(null);
        setForecastData(null);
        setSelectedColDropdown("");
        setChatMessages([]);
        setSummary({ total_records: 0, numeric_aggregates: {}, all_columns: [], selected_kpis: [], column_types: {}, active_file: "None Loaded" });
        setShowPreviewModal(false);
        setTablePreviewRows([]);
      }
    } catch (err) {
      console.error("Purge commands loop error:", err);
    }
  };

  const handleExecuteFormula = async (e) => {
    e.preventDefault();
    setFormulaEngineError("");
    try {
      const response = await fetch('http://127.0.0.1:8000/api/analytics/custom_measure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formula: customFormulaText, measure_name: customMeasureName })
      });
      const resultData = await response.json();
      if (response.ok) {
        setCustomKpisList((prev) => [...prev, resultData]);
        setCustomMeasureName("");
        setCustomFormulaText("");
        await refreshPlatformData();
      } else {
        setFormulaEngineError(resultData.detail || "DAX compilation fault.");
      }
    } catch (err) {
      setFormulaEngineError("Failed to lock gateway compilation loop thread.");
    }
  };

  const handleSendChatMessage = async (e) => {
    e.preventDefault();
    const question = chatInput.trim();
    if (!question || chatLoading || summary.total_records === 0) return;

    const updatedHistory = [...chatMessages, { role: 'user', content: question }];
    setChatMessages(updatedHistory);
    setChatInput("");
    setChatLoading(true);
    try {
      const res = await fetch('http://127.0.0.1:8000/api/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: updatedHistory.slice(0, -1).slice(-6) })
      });
      const data = await res.json();
      if (res.ok) {
        setChatMessages((prev) => [...prev, { role: 'assistant', content: data.answer, sql_used: data.sql_used }]);
      } else {
        setChatMessages((prev) => [...prev, { role: 'assistant', content: `⚠️ ${data.detail || "Failed to get an answer."}` }]);
      }
    } catch (err) {
      setChatMessages((prev) => [...prev, { role: 'assistant', content: "⚠️ Failed to reach the AI engine. Confirm the gateway is running." }]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleDeleteCustomKpi = (idxToDelete) => {
    setCustomKpisList((prevList) => prevList.filter((_, idx) => idx !== idxToDelete));
  };

  const appendDropdownTokenToFormulaInput = (functionType) => {
    setCustomFormulaText(`${functionType}(${selectedColDropdown})`);
  };

  const targetMetrics = summary.selected_kpis || [];
  const COLORS_PALETTE = ['#3b82f6', '#22c55e', '#ea580c', '#a855f7', '#eab308', '#ec4899', '#14b8a6'];

  if (!isAuthenticated) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a', fontFamily: 'sans-serif' }}>
        <form onSubmit={handleLogin} style={{ background: '#171717', border: '1px solid #262626', padding: '40px', borderRadius: '12px', width: '100%', maxWidth: '380px' }}>
          <div style={{ textAlign: 'center', marginBottom: '30px' }}>
            <h2 style={{ color: '#fff', margin: 0, fontSize: '24px', fontWeight: '700' }}>StratAI Secure Access</h2>
            <p style={{ color: '#737373', fontSize: '13px', marginTop: '6px' }}>Enterprise Workspace Authorization Center</p>
          </div>
          {authError && <div style={{ background: '#7f1d1d', border: '1px solid #ef4444', color: '#fca5a5', padding: '10px', borderRadius: '6px', fontSize: '13px', marginBottom: '16px', textAlign: 'center' }}>⚠️ {authError}</div>}
          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', color: '#a3a3a3', fontSize: '12px', marginBottom: '6px' }}>Executive Email</label>
            <input type="email" placeholder="admin@stratai.com" value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: '100%', background: '#0a0a0a', border: '1px solid #404040', padding: '12px', borderRadius: '6px', color: '#fff', fontSize: '14px', boxSizing: 'border-box' }} required />
          </div>
          <div style={{ marginBottom: '30px' }}>
            <label style={{ display: 'block', color: '#a3a3a3', fontSize: '12px', marginBottom: '6px' }}>Security Password</label>
            <input type="password" placeholder="•••••" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%', background: '#0a0a0a', border: '1px solid #404040', padding: '12px', borderRadius: '6px', color: '#fff', fontSize: '14px', boxSizing: 'border-box' }} required />
          </div>
          <button type="submit" style={{ width: '100%', background: '#2563eb', color: '#fff', border: 'none', padding: '14px', borderRadius: '6px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer' }}>Unlock Workspace</button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#0a0a0a', color: '#e5e5e5', fontFamily: 'sans-serif' }}>

      <aside style={{ width: '280px', backgroundColor: '#171717', borderRight: '1px solid #262626', display: 'flex', flexDirection: 'column', padding: '24px', boxSizing: 'border-box' }}>
        <div style={{ marginBottom: '35px' }}>
          <h2 style={{ color: '#fff', margin: 0, fontSize: '24px', fontWeight: '700' }}>StratAI Workspace</h2>
          <p style={{ color: '#22c55e', fontSize: '12px', fontWeight: '600', margin: '6px 0 0 0' }}>● Secure Core Active</p>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexGrow: 1 }}>
          <button onClick={() => setActiveTab('overview')} style={{ textAlign: 'left', padding: '12px 16px', borderRadius: '6px', border: 'none', background: activeTab === 'overview' ? '#2563eb' : 'transparent', color: '#fff', fontSize: '14px', cursor: 'pointer' }}>🏢 Overview & Scorecards</button>
          <button onClick={() => setActiveTab('charts')} style={{ textAlign: 'left', padding: '12px 16px', borderRadius: '6px', border: 'none', background: activeTab === 'charts' ? '#2563eb' : 'transparent', color: '#fff', fontSize: '14px', cursor: 'pointer' }}>📊 Analytics Dashboards</button>
          <button onClick={() => setActiveTab('assistant')} style={{ textAlign: 'left', padding: '12px 16px', borderRadius: '6px', border: 'none', background: activeTab === 'assistant' ? '#2563eb' : 'transparent', color: '#fff', fontSize: '14px', cursor: 'pointer' }}>🧠 AI Boardroom Assistant</button>
          <button onClick={() => setActiveTab('predictive')} style={{ textAlign: 'left', padding: '12px 16px', borderRadius: '6px', border: 'none', background: activeTab === 'predictive' ? '#2563eb' : 'transparent', color: '#fff', fontSize: '14px', cursor: 'pointer' }}>🔮 Predictive Forecast Engine</button>
          <button onClick={() => setActiveTab('configuration')} style={{ textAlign: 'left', padding: '12px 16px', borderRadius: '6px', border: 'none', background: activeTab === 'configuration' ? '#2563eb' : 'transparent', color: '#fff', fontSize: '14px', cursor: 'pointer' }}>⚙️ Workspace Configuration</button>
        </nav>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label style={{ background: '#262626', color: '#fff', padding: '12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', textAlign: 'center', fontWeight: 'bold', border: '1px solid #404040' }}>
            <span>{loading ? "Streaming Logs..." : "📤 Ingest New CSV"}</span>
            <input type="file" accept=".csv" onChange={handleFileUpload} style={{ display: 'none' }} disabled={loading} />
          </label>
          <button onClick={() => setIsAuthenticated(false)} style={{ background: 'transparent', color: '#ef4444', border: '1px solid #991b1b', padding: '10px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>🔒 Log Out</button>
        </div>
      </aside>

      <main style={{ flexGrow: 1, padding: '40px', overflowY: 'auto', height: '100vh', boxSizing: 'border-box' }}>
        {uploadStatus && <div style={{ background: '#1e3a8a', color: '#93c5fd', padding: '12px 20px', borderRadius: '6px', marginBottom: '24px', fontSize: '14px' }}>⚡ System Alert: {uploadStatus}</div>}

        {/* SECTION 1: EXECUTIVE OVERVIEW SCORECARDS */}
        {activeTab === 'overview' && (
          <div>
            <div style={{ marginBottom: '30px' }}>
              <h2 style={{ color: '#fff', margin: '0 0 6px 0', fontSize: '28px', fontWeight: '700' }}>🏢 Overview & Executive Scorecards</h2>
              <p style={{ color: '#a3a3a3', margin: 0, fontSize: '14px' }}>Descriptive summary metrics dashboards with integrated real-time custom DAX formula mapping capabilities.</p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '20px', marginBottom: '35px' }}>
              <div style={{ background: '#171717', padding: '24px', borderRadius: '8px', border: '1px solid #262626' }}>
                <div style={{ color: '#737373', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Ingested Matrix Rows</div>
                <div style={{ color: '#2563eb', fontSize: '36px', fontWeight: 'bold', marginTop: '8px' }}>{summary.total_records?.toLocaleString() ?? 0}</div>
              </div>

              {/* Auto-selected KPIs: the backend picks the columns with the
                  strongest signal (highest variability, excluding IDs), and
                  also tells us which aggregation + DAX-style formula it used,
                  so this works the same way no matter what CSV is loaded. */}
              {targetMetrics.map((metric, idx) => {
                const colors = ['#3b82f6', '#22c55e', '#a855f7'];
                const aggInfo = summary.numeric_aggregates[metric] || {};
                const recommendedAgg = aggInfo.recommended_agg || 'mean';
                const displayValue = aggInfo[recommendedAgg] ?? 0;
                const aggLabel = aggInfo.recommended_label || 'AVERAGE';
                return (
                  <div key={metric} style={{ background: '#171717', padding: '24px', borderRadius: '8px', border: '1px solid #262626' }}>
                    <div style={{ color: '#737373', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>Auto KPI: {metric.replace(/_/g, ' ')} ({aggLabel})</div>
                    <div style={{ color: colors[idx % 3], fontSize: '36px', fontWeight: 'bold', marginTop: '8px' }}>{displayValue}</div>
                    <div style={{ color: '#525252', fontSize: '11px', fontFamily: 'monospace', marginTop: '6px' }}>fx: {aggInfo.dax_formula || `${aggLabel}(${metric})`}</div>
                  </div>
                );
              })}

              {customKpisList.map((kpi, idx) => (
                <div key={`custom-${idx}`} style={{ background: '#0f172a', padding: '24px', borderRadius: '8px', border: '1px solid #1e3a8a', position: 'relative' }}>
                  <button
                    onClick={() => handleDeleteCustomKpi(idx)}
                    style={{ position: 'absolute', top: '12px', right: '12px', background: 'transparent', border: 'none', color: '#ef4444', fontSize: '11px', cursor: 'pointer' }}
                  >
                    🗑️ Delete
                  </button>
                  <div style={{ color: '#93c5fd', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>★ {kpi.measure_name}</div>
                  <div style={{ color: '#fff', fontSize: '36px', fontWeight: 'bold', marginTop: '8px' }}>{kpi.result_value}</div>
                  <div style={{ color: '#475569', fontSize: '11px', fontFamily: 'monospace', marginTop: '6px' }}>fx: {kpi.formula_applied}</div>
                </div>
              ))}
            </div>

            <div style={{ background: '#171717', padding: '30px', borderRadius: '8px', border: '1px solid #262626', marginBottom: '35px' }}>
              <h3 style={{ color: '#fff', margin: '0 0 8px 0', fontSize: '16px', fontWeight: '600' }}>🛠️ Custom Metric Expression Builder (Simulated DAX Pipeline)</h3>
              <form onSubmit={handleExecuteFormula} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: '220px' }}>
                    <select value={selectedColDropdown} onChange={(e) => setSelectedColDropdown(e.target.value)} style={{ width: '100%', background: '#0a0a0a', border: '1px solid #404040', padding: '10px', borderRadius: '6px', color: '#fff', fontSize: '14px' }}>
                      {summary.all_columns && summary.all_columns.map(col => <option key={col} value={col}>{col}</option>)}
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button type="button" onClick={() => appendDropdownTokenToFormulaInput('SUM')} style={{ background: '#262626', border: '1px solid #404040', color: '#fff', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>+ SUM</button>
                    <button type="button" onClick={() => appendDropdownTokenToFormulaInput('AVERAGE')} style={{ background: '#262626', border: '1px solid #404040', color: '#fff', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>+ AVERAGE</button>
                    <button type="button" onClick={() => appendDropdownTokenToFormulaInput('MAX')} style={{ background: '#262626', border: '1px solid #404040', color: '#fff', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>+ MAX</button>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '15px' }}>
                  <input type="text" placeholder="Custom Metric Title" value={customMeasureName} onChange={(e) => setCustomMeasureName(e.target.value)} style={{ width: '100%', background: '#0a0a0a', border: '1px solid #404040', padding: '12px', borderRadius: '6px', color: '#fff' }} required />
                  <input type="text" placeholder="Formula String Expression" value={customFormulaText} onChange={(e) => setCustomFormulaText(e.target.value)} style={{ width: '100%', background: '#0a0a0a', border: '1px solid #404040', padding: '12px', borderRadius: '6px', color: '#fff', fontFamily: 'monospace' }} required />
                </div>
                <button type="submit" style={{ alignSelf: 'flex-start', background: '#2563eb', color: '#fff', border: 'none', padding: '12px 24px', borderRadius: '6px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer' }}>🧮 Compile Dashboard Metric Card</button>
              </form>
              {formulaEngineError && <p style={{ color: '#f87171', fontSize: '13px', marginTop: '14px', marginBottom: 0 }}>⚠️ {formulaEngineError}</p>}
            </div>

            <div style={{ background: '#171717', padding: '30px', borderRadius: '8px', border: '1px solid #262626', marginBottom: '35px' }}>
              <h3 style={{ color: '#fff', margin: '0 0 15px 0', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>📋 Dataset Columns Schema</h3>
              {summary.total_records > 0 ? (
                <div style={{ color: '#3b82f6', background: '#0a0a0a', padding: '20px', borderRadius: '6px', borderLeft: '4px solid #2563eb', fontFamily: 'monospace', fontSize: '14px', lineHeight: '1.6' }}>
                  {(summary.all_columns || []).join(', ')}
                </div>
              ) : (
                <p style={{ color: '#737373', fontSize: '14px', margin: 0, textAlign: 'center', padding: '10px 0' }}>Awaiting dataset upload. Stream in a configuration CSV file to populate column tokens.</p>
              )}
            </div>

            <div style={{ background: '#171717', padding: '24px', borderRadius: '8px', border: '1px solid #262626', borderTop: '3px solid #3b82f6' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '20px' }}>
                <div>
                  <h4 style={{ color: '#fff', margin: '0 0 4px 0', fontSize: '14px', fontWeight: '600' }}>📂 Active Ingested Source Registry</h4>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <button onClick={handleOpenFilePreview} disabled={summary.total_records === 0} style={{ background: '#0a0a0a', border: '1px solid #3b82f6', padding: '10px 16px', borderRadius: '6px', fontSize: '13px', color: summary.total_records > 0 ? '#60a5fa' : '#404040', fontFamily: 'monospace', fontWeight: 'bold', cursor: summary.total_records > 0 ? 'pointer' : 'default', textDecoration: summary.total_records > 0 ? 'underline' : 'none' }}>
                    📄 {summary.active_file || "None Loaded"} {summary.total_records > 0 && "🔗"}
                  </button>
                  {summary.total_records > 0 && (
                    <button onClick={handlePurgeDataset} style={{ background: '#7f1d1d', color: '#fca5a5', border: '1px solid #ef4444', padding: '10px 16px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>🗑️ Delete Active File Node</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SECTION 2: AUTO-INTELLIGENT ANALYTICS WORKSPACE */}
        {activeTab === 'charts' && (
          <div>
            <div style={{ marginBottom: '30px', borderBottom: '1px solid #262626', paddingBottom: '15px' }}>
              <h2 style={{ color: '#fff', margin: '0 0 6px 0', fontSize: '28px', fontWeight: '700' }}>📊 Analytics Core Dashboards</h2>
              <p style={{ color: '#a3a3a3', margin: 0, fontSize: '14px' }}>Automatically selected metrics and breakdowns based on the active dataset — updates whenever a new file is uploaded.</p>
            </div>

            {autoInsights && summary.total_records > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '40px' }}>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px' }}>

                  <div style={{ background: '#171717', padding: '24px', borderRadius: '8px', border: '1px solid #262626', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ marginBottom: '12px' }}>
                      <h4 style={{ color: '#3b82f6', margin: 0, fontSize: '14px', fontWeight: 'bold' }}>1. Key Trend: {autoInsights.trend_column || 'N/A'}</h4>
                    </div>
                    <div style={{ width: '100%', height: '220px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={autoInsights.trend_data} margin={{ top: 10, right: 10, left: 15, bottom: 20 }}>
                          <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
                          <XAxis dataKey="x_val" stroke="#a3a3a3" fontSize={11}>
                            <Label value="Record #" offset={-10} position="insideBottom" fill="#737373" fontSize={11} fontWeight="600" />
                          </XAxis>
                          <YAxis stroke="#a3a3a3" fontSize={11}>
                            <Label value={autoInsights.trend_column || 'Value'} angle={-90} position="insideLeft" style={{ textAnchor: 'middle' }} fill="#737373" fontSize={11} fontWeight="600" offset={-5} />
                          </YAxis>
                          <Tooltip contentStyle={{ backgroundColor: '#171717', color: '#fff', borderColor: '#262626' }} />
                          <Legend verticalAlign="top" height={28} />
                          <Area type="monotone" dataKey="y_val" name={autoInsights.trend_column || 'Value'} stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.08} strokeWidth={2} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                    <p style={{ color: '#8a8a8a', fontSize: '12px', lineHeight: '1.5', marginTop: '10px', marginBottom: 0 }}>{autoInsights.trend_explanation}</p>
                  </div>

                  <div style={{ background: '#171717', padding: '24px', borderRadius: '8px', border: '1px solid #262626', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ marginBottom: '12px' }}>
                      <h4 style={{ color: '#22c55e', margin: 0, fontSize: '14px', fontWeight: 'bold' }}>2. Key Breakdown: {autoInsights.pie_column || 'N/A'}</h4>
                    </div>
                    <div style={{ width: '100%', height: '220px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        {autoInsights.pie_data && autoInsights.pie_data.length > 0 ? (
                          <PieChart>
                            <Tooltip contentStyle={{ backgroundColor: '#171717', color: '#fff', borderColor: '#262626' }} />
                            <Legend
                              verticalAlign="bottom" align="center" iconSize={10}
                              wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }}
                              formatter={(value) => (value && value.length > 22 ? `${value.slice(0, 22)}…` : value)}
                            />
                            <Pie data={autoInsights.pie_data} dataKey="y_val" nameKey="x_val" cx="50%" cy="42%" innerRadius={50} outerRadius={72} paddingAngle={4} label={{ fill: '#e5e5e5', fontSize: 10 }}>
                              {autoInsights.pie_data.map((entry, idx) => (
                                <Cell key={`cell-vital-${idx}`} fill={COLORS_PALETTE[idx % COLORS_PALETTE.length]} />
                              ))}
                            </Pie>
                          </PieChart>
                        ) : (
                          <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#737373', fontSize: '13px' }}>No suitable category column detected.</div>
                        )}
                      </ResponsiveContainer>
                    </div>
                    <p style={{ color: '#8a8a8a', fontSize: '12px', lineHeight: '1.5', marginTop: '10px', marginBottom: 0 }}>{autoInsights.pie_explanation}</p>
                  </div>

                </div>

                <div style={{ background: '#171717', padding: '24px', borderRadius: '8px', border: '1px solid #262626', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ marginBottom: '12px' }}>
                    <h4 style={{ color: '#a855f7', margin: 0, fontSize: '14px', fontWeight: 'bold' }}>
                      3. Key Comparison: Avg {autoInsights.comparison_metric || '—'} by {autoInsights.comparison_category || '—'}
                    </h4>
                  </div>
                  <div style={{ width: '100%', height: '260px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      {autoInsights.comparison_data && autoInsights.comparison_data.length > 0 ? (
                        <BarChart data={autoInsights.comparison_data} margin={{ top: 10, right: 15, left: 15, bottom: 30 }}>
                          <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
                          <XAxis dataKey="category" stroke="#a3a3a3" fontSize={11} angle={-15} textAnchor="end" height={50}>
                            <Label value={autoInsights.comparison_category || 'Category'} offset={-2} position="insideBottom" fill="#737373" fontSize={11} fontWeight="600" />
                          </XAxis>
                          <YAxis stroke="#a3a3a3" fontSize={11}>
                            <Label value={`Avg ${autoInsights.comparison_metric || ''}`} angle={-90} position="insideLeft" style={{ textAnchor: 'middle' }} fill="#737373" fontSize={11} fontWeight="600" offset={-5} />
                          </YAxis>
                          <Tooltip contentStyle={{ backgroundColor: '#171717', color: '#fff', borderColor: '#262626' }} />
                          <Legend verticalAlign="top" height={28} />
                          <Bar dataKey="value" name={`Avg ${autoInsights.comparison_metric || ''}`} fill="#a855f7" radius={[4, 4, 0, 0]} maxBarSize={60} />
                        </BarChart>
                      ) : (
                        <div style={{ display: 'flex', height: '100%', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#737373', padding: '40px', textAlign: 'center' }}>
                          <span style={{ fontSize: '24px', marginBottom: '6px' }}>🧮</span>
                          <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.4', maxWidth: '420px' }}>Need at least one numeric and one categorical column detected in the dataset to build this comparison.</p>
                        </div>
                      )}
                    </ResponsiveContainer>
                  </div>
                  <p style={{ color: '#8a8a8a', fontSize: '12px', lineHeight: '1.5', marginTop: '10px', marginBottom: 0 }}>{autoInsights.comparison_explanation}</p>
                </div>

              </div>
            ) : (
              <div style={{ background: '#171717', padding: '80px 40px', borderRadius: '8px', border: '1px solid #262626', textAlign: 'center', color: '#737373' }}>
                <span style={{ fontSize: '32px', display: 'block', marginBottom: '10px' }}>📊</span>
                <h4>Awaiting active source worksheet profile ingestion loop.</h4>
                <p style={{ fontSize: '13px', maxWidth: '440px', margin: '6px auto 0 auto', lineHeight: '1.5' }}>Upload a structured business or HR data document inside the primary dashboard pane to trigger autonomous analytics graphs plotting profiles.</p>
              </div>
            )}
          </div>
        )}

        {/* SUB-TABS VIEWS TIERS 3-6 */}
        {activeTab === 'assistant' && (
          <div style={{ maxWidth: '900px', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 160px)' }}>
            <div style={{ marginBottom: '20px' }}>
              <h2 style={{ color: '#fff', margin: '0 0 6px 0', fontSize: '28px', fontWeight: '700' }}>🧠 AI Boardroom Assistant</h2>
              <p style={{ color: '#a3a3a3', margin: 0, fontSize: '14px' }}>Ask anything about "{summary.active_file}" — the assistant answers from live stats computed over your uploaded dataset, and runs an exact query behind the scenes for precise numbers.</p>
            </div>

            <div style={{ flexGrow: 1, background: '#171717', border: '1px solid #262626', borderRadius: '8px', padding: '24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {chatMessages.length === 0 && (
                <div style={{ color: '#737373', fontSize: '13.5px', lineHeight: '1.6' }}>
                  {summary.total_records > 0 ? (
                    <>
                      💬 Try asking things like:
                      <ul style={{ marginTop: '10px', paddingLeft: '20px' }}>
                        <li>"What's the average {targetMetrics[0] || 'rating'} in this dataset?"</li>
                        <li>"Which column has the most missing values?"</li>
                        <li>"Summarize the key patterns in this data."</li>
                        <li>"How does {targetMetrics[0] || 'the top metric'} vary across categories?"</li>
                        <li>"Show me the top 5 rows by {targetMetrics[0] || 'the top metric'}."</li>
                      </ul>
                    </>
                  ) : (
                    "Upload a dataset first — once ingested, ask me anything about it in plain English."
                  )}
                </div>
              )}

              {chatMessages.map((msg, idx) => (
                <div
                  key={idx}
                  style={{
                    alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '78%',
                    background: msg.role === 'user' ? '#2563eb' : '#262626',
                    color: '#fff',
                    padding: '12px 16px',
                    borderRadius: '10px',
                    fontSize: '14px',
                    lineHeight: '1.6',
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {msg.content}
                  {msg.sql_used && (
                    <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #3f3f3f', fontSize: '11px', color: '#93c5fd', fontFamily: 'monospace', opacity: 0.85, whiteSpace: 'pre-wrap' }}>
                      fx: {msg.sql_used}
                    </div>
                  )}
                </div>
              ))}

              {chatLoading && (
                <div style={{ alignSelf: 'flex-start', color: '#737373', fontSize: '13px', fontStyle: 'italic' }}>🧠 Analyzing dataset context...</div>
              )}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleSendChatMessage} style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={summary.total_records > 0 ? "Ask a question about your data..." : "Upload a dataset to enable chat..."}
                disabled={summary.total_records === 0}
                style={{ flexGrow: 1, background: '#0a0a0a', border: '1px solid #404040', padding: '14px', borderRadius: '6px', color: '#fff', fontSize: '14px' }}
              />
              <button
                type="submit"
                disabled={chatLoading || summary.total_records === 0 || !chatInput.trim()}
                style={{ background: '#2563eb', color: '#fff', border: 'none', padding: '14px 24px', borderRadius: '6px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', opacity: (chatLoading || summary.total_records === 0) ? 0.5 : 1 }}
              >
                {chatLoading ? "..." : "Send"}
              </button>
            </form>
          </div>
        )}

        {activeTab === 'predictive' && (
          <div>
            <div style={{ marginBottom: '30px' }}>
              <h2 style={{ color: '#fff', margin: '0 0 6px 0', fontSize: '28px', fontWeight: '700' }}>🔮 Predictive Forecast Engine</h2>
              <p style={{ color: '#a3a3a3', margin: 0, fontSize: '14px' }}>Linear-regression projection of the same key trend from Analytics Dashboards, plus AI-generated measures and suggestions on what to change.</p>
            </div>

            {forecastData && summary.total_records > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>

                {/* Forecast chart: historical actuals -> projected trajectory */}
                <div style={{ background: '#171717', padding: '24px', borderRadius: '8px', border: '1px solid #262626' }}>
                  <h4 style={{ color: '#a855f7', margin: '0 0 12px 0', fontSize: '14px', fontWeight: 'bold' }}>
                    Projected Trajectory: {forecastData.trend_column} ({forecastData.direction})
                  </h4>
                  <div style={{ width: '100%', height: '260px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={forecastData.forecast_data} margin={{ top: 10, right: 15, left: 15, bottom: 20 }}>
                        <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
                        <XAxis dataKey="x_val" stroke="#a3a3a3" fontSize={11}>
                          <Label value="Record # (projected beyond dashed line)" offset={-10} position="insideBottom" fill="#737373" fontSize={11} fontWeight="600" />
                        </XAxis>
                        <YAxis stroke="#a3a3a3" fontSize={11} />
                        <Tooltip contentStyle={{ backgroundColor: '#171717', color: '#fff', borderColor: '#262626' }} />
                        <Legend verticalAlign="top" height={28} />
                        <Area type="monotone" dataKey="actual" name={`${forecastData.trend_column} (actual)`} stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.08} strokeWidth={2} connectNulls={false} />
                        <Area type="monotone" dataKey="projected" name="Projected" stroke="#a855f7" strokeDasharray="6 4" fill="#a855f7" fillOpacity={0.05} strokeWidth={2} connectNulls />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Key measures: per-metric current vs projected, with pct change */}
                <div>
                  <h4 style={{ color: '#fff', margin: '0 0 12px 0', fontSize: '14px', fontWeight: 'bold' }}>📐 Key Measures</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '16px' }}>
                    {(forecastData.key_measures || []).map((m, idx) => {
                      const isUp = m.pct_change > 0;
                      const isFlat = Math.abs(m.pct_change) < 0.5;
                      const changeColor = isFlat ? '#a3a3a3' : (isUp ? '#22c55e' : '#ef4444');
                      return (
                        <div key={m.metric} style={{ background: '#171717', padding: '20px', borderRadius: '8px', border: '1px solid #262626' }}>
                          <div style={{ color: '#737373', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>{m.metric.replace(/_/g, ' ')} ({m.trend})</div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginTop: '8px' }}>
                            <span style={{ color: '#fff', fontSize: '22px', fontWeight: 'bold' }}>{m.current_value}</span>
                            <span style={{ color: '#525252', fontSize: '13px' }}>→</span>
                            <span style={{ color: '#e5e5e5', fontSize: '22px', fontWeight: 'bold' }}>{m.projected_value}</span>
                          </div>
                          <div style={{ color: changeColor, fontSize: '12px', fontWeight: 'bold', marginTop: '6px' }}>
                            {isFlat ? '● stable' : (isUp ? `▲ +${m.pct_change}%` : `▼ ${m.pct_change}%`)} projected
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* AI-generated measures & suggestions grounded in the chart context above */}
                <div style={{ background: '#171717', padding: '30px', borderRadius: '8px', border: '1px solid #a855f7', borderLeftWidth: '6px' }}>
                  <h4 style={{ color: '#fff', margin: '0 0 12px 0', fontSize: '14px', fontWeight: 'bold' }}>🧠 AI Measures & Suggestions</h4>
                  <div style={{ lineHeight: '1.7', whiteSpace: 'pre-wrap', color: '#e5e5e5', fontSize: '14px' }}>
                    {forecastData.ai_recommendations}
                  </div>
                </div>

              </div>
            ) : (
              <div style={{ background: '#171717', padding: '80px 40px', borderRadius: '8px', border: '1px solid #262626', textAlign: 'center', color: '#737373' }}>
                <span style={{ fontSize: '32px', display: 'block', marginBottom: '10px' }}>🔮</span>
                <h4>Awaiting active dataset to build a forecast.</h4>
                <p style={{ fontSize: '13px', maxWidth: '440px', margin: '6px auto 0 auto', lineHeight: '1.5' }}>Upload a dataset with at least one numeric column to enable trajectory projection and AI-generated measures.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'configuration' && (
          <div>
            <h2 style={{ color: '#fff', margin: '0 0 6px 0', fontSize: '28px', fontWeight: '700' }}>⚙️ Workspace Configuration</h2>
            <div style={{ background: '#171717', borderRadius: '8px', border: '1px solid #262626', padding: '24px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #404040', color: '#a3a3a3' }}><th style={{ padding: '12px' }}>Constant Key Target</th><th style={{ padding: '12px' }}>Operational Network State</th></tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid #262626' }}><td style={{ padding: '12px', color: '#fff' }}>Local Gateway API Target Loopback</td><td style={{ padding: '12px', color: '#22c55e', fontWeight: 'bold' }}>Port 8000 Listening</td></tr>
                  <tr><td style={{ padding: '12px', color: '#fff' }}>Cognitive Handshake Loops Pipeline</td><td style={{ padding: '12px', color: '#3b82f6', fontWeight: 'bold' }}>Google Gemini Core Synced</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* MODAL PREVIEW OVERLAY */}
        {showPreviewModal && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '40px' }}>
            <div style={{ background: '#171717', border: '1px solid #262626', borderRadius: '12px', width: '100%', maxWidth: '1100px', maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #262626', display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1f1f1f' }}>
                <div>
                  <h3 style={{ color: '#fff', margin: 0, fontSize: '16px', fontWeight: 'bold' }}>🔍 Dynamic Data Preview Node: {summary.active_file}</h3>
                </div>
                <button onClick={() => setShowPreviewModal(false)} style={{ background: '#262626', border: '1px solid #404040', color: '#fff', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>✕ Close Preview</button>
              </div>
              <div style={{ padding: '24px', overflow: 'auto', flexGrow: 1, backgroundColor: '#0a0a0a' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12.5px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #404040', color: '#a3a3a3', backgroundColor: '#171717' }}>
                      <th style={{ padding: '12px' }}>Row Index</th>
                      {summary.all_columns && summary.all_columns.map(col => <th key={col} style={{ padding: '12px', color: '#60a5fa', fontFamily: 'monospace' }}>{col}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {tablePreviewRows.map((row, rIdx) => (
                      <tr key={rIdx} style={{ borderBottom: '1px solid #262626', backgroundColor: rIdx % 2 === 0 ? 'transparent' : '#111' }}>
                        <td style={{ padding: '12px', color: '#737373', fontWeight: 'bold' }}>#{row._row_index + 1}</td>
                        {summary.all_columns && summary.all_columns.map(col => <td key={col} style={{ padding: '12px', color: '#e5e5e5', fontFamily: 'monospace' }}>{String(row[col])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}