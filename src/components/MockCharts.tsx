
export function MockLineChart({ title }: { title: string }) {
  return (
    <div className="chart-container">
      <svg width="100%" height="100%" viewBox="0 0 400 100" preserveAspectRatio="none">
        <polyline 
          fill="none" stroke="#2563eb" strokeWidth="3" 
          points="0,80 50,40 100,50 150,20 200,60 250,10 300,30 350,15 400,40" 
        />
        <polyline 
          fill="none" stroke="#94a3b8" strokeWidth="2" strokeDasharray="4"
          points="0,90 100,70 200,80 300,50 400,60" 
        />
      </svg>
      <span style={{ position: 'absolute' }}>{title}</span>
    </div>
  );
}

export function MockBarChart({ title }: { title: string }) {
  return (
    <div className="chart-container">
      <svg width="200" height="150" viewBox="0 0 200 150">
        <rect x="40" y="20" width="40" height="130" fill="#2563eb" />
        <text x="60" y="145" fill="white" fontSize="12" textAnchor="middle">Msg</text>
        <rect x="120" y="90" width="40" height="60" fill="#94a3b8" />
        <text x="140" y="145" fill="white" fontSize="12" textAnchor="middle">Cloud</text>
      </svg>
      <span style={{ position: 'absolute', top: 10 }}>{title}</span>
    </div>
  );
}