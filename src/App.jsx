import React, { useState, useEffect } from 'react';
import { Calendar, CheckCircle2, Circle, Users, Home, LogOut, ChevronLeft, ChevronRight, Plus, X, MessageSquare, FileText, Trophy } from 'lucide-react';

const INITIAL_STATE = {
  users: [
    { id: 1, name: 'Nicholas', role: 'child', age: 'older', password: 'nick123' },
    { id: 2, name: 'Emilie', role: 'child', age: 'older', password: 'emilie123' },
    { id: 3, name: 'Carter', role: 'child', age: 'older', password: 'carter123' },
    { id: 4, name: 'Cole', role: 'child', age: 'older', password: 'cole123' },
    { id: 5, name: 'Finn', role: 'child', age: 'younger', password: 'finn123' },
    { id: 6, name: 'Liam', role: 'child', age: 'younger', password: 'liam123' },
    { id: 7, name: 'Mom', role: 'parent', password: 'mom123' },
    { id: 8, name: 'Dad', role: 'parent', password: 'dad123' }
  ]
};

const DAILY_CHORES_ROTATION = {
  Sunday: [
    { zone: null, dinner: 'Dishes' },
    { zone: 'Kitchen Floor', dinner: 'Sweep' },
    { zone: 'Family Room/Vacuum', dinner: 'Take Out Trash' },
    { zone: 'Office/Front Hall', dinner: 'Clear Table' }
  ],
  Monday: [
    { zone: 'Office/Front Hall', dinner: 'Clear Table' },
    { zone: 'Family Room/Vacuum', dinner: 'Take Out Trash' },
    { zone: null, dinner: 'Dishes' },
    { zone: 'Kitchen Floor', dinner: 'Sweep' }
  ],
  Tuesday: [
    { zone: null, dinner: 'Dishes' },
    { zone: 'Kitchen Floor', dinner: 'Sweep' },
    { zone: 'Family Room/Vacuum', dinner: 'Take Out Trash' },
    { zone: 'Office/Front Hall', dinner: 'Clear Table' }
  ],
  Wednesday: [
    { zone: 'Family Room/Vacuum', dinner: 'Take Out Trash' },
    { zone: 'Office/Front Hall', dinner: 'Clear Table' },
    { zone: 'Kitchen Floor', dinner: 'Sweep' },
    { zone: null, dinner: 'Dishes' }
  ],
  Thursday: [
    { zone: 'Kitchen Floor', dinner: 'Sweep' },
    { zone: null, dinner: 'Dishes' },
    { zone: 'Office/Front Hall', dinner: 'Clear Table' },
    { zone: 'Family Room/Vacuum', dinner: 'Take Out Trash' }
  ],
  Friday: [
    { zone: 'Office/Front Hall', dinner: 'Clear Table' },
    { zone: 'Family Room/Vacuum', dinner: 'Take Out Trash' },
    { zone: null, dinner: 'Dishes' },
    { zone: 'Kitchen Floor', dinner: 'Sweep' }
  ],
  Saturday: [
    { zone: 'Office/Front Hall', dinner: 'Clear Table' },
    { zone: null, dinner: 'Dishes' },
    { zone: 'Kitchen Floor', dinner: 'Sweep' },
    { zone: 'Family Room/Vacuum', dinner: 'Take Out Trash' }
  ]
};

const WEEKLY_CHORES = [
  'Collect Trash',
  'Take Trash/Recycle to Curb',
  'Bring Cans In',
  'Refill Soap',
  'Toilet Paper'
];

const WEEKLY_ROTATION_START = {
  date: new Date('2025-10-20'),
  assignments: ['Emilie', 'Nicholas', 'Cole', 'Finn', 'Liam', 'Carter']
};

const CHORE_POINTS = {
  zone: 5,
  dinner: 5,
  daily: 3,
  weekly: 10,
  custom: 10
};

const TEAMS = {
  Team1: ['Nicholas', 'Carter', 'Finn'],
  Team2: ['Emilie', 'Cole', 'Liam']
};

const TEAM_ROTATIONS = [
  { 
    Team1: ['Nicholas', 'Carter', 'Finn'],
    Team2: ['Emilie', 'Cole', 'Liam'],
    captains: { Team1: 'Nicholas', Team2: 'Emilie' }
  },
  { 
    Team1: ['Nicholas', 'Emilie', 'Liam'],
    Team2: ['Carter', 'Cole', 'Finn'],
    captains: { Team1: 'Liam', Team2: 'Finn' }
  },
  { 
    Team1: ['Nicholas', 'Cole', 'Finn'],
    Team2: ['Emilie', 'Carter', 'Liam'],
    captains: { Team1: 'Cole', Team2: 'Carter' }
  },
  { 
    Team1: ['Carter', 'Emilie', 'Finn'],
    Team2: ['Nicholas', 'Cole', 'Liam'],
    captains: { Team1: 'Finn', Team2: 'Liam' }
  },
  { 
    Team1: ['Nicholas', 'Carter', 'Liam'],
    Team2: ['Emilie', 'Cole', 'Finn'],
    captains: { Team1: 'Carter', Team2: 'Cole' }
  },
  { 
    Team1: ['Nicholas', 'Emilie', 'Finn'],
    Team2: ['Carter', 'Cole', 'Liam'],
    captains: { Team1: 'Emilie', Team2: 'Nicholas' }
  }
];

function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [loginForm, setLoginForm] = useState({ name: '', password: '' });
  const [assignments, setAssignments] = useState({});
  const [viewDate, setViewDate] = useState(new Date());
  const [completionData, setCompletionData] = useState({});
  const [customTasks, setCustomTasks] = useState({});
  const [choreNotes, setChoreNotes] = useState({});
  const [showAddTaskModal, setShowAddTaskModal] = useState(false);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [selectedChore, setSelectedChore] = useState(null);
  const [newTask, setNewTask] = useState({ kid: '', description: '', note: '', points: 10, startDate: '', dueDate: '' });
  const [userPoints, setUserPoints] = useState({
    Nicholas: 0,
    Emilie: 0,
    Carter: 0,
    Cole: 0,
    Finn: 0,
    Liam: 0
  });
  const [monthlyPoints, setMonthlyPoints] = useState({
    Nicholas: 0,
    Emilie: 0,
    Carter: 0,
    Cole: 0,
    Finn: 0,
    Liam: 0
  });
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [teamNames, setTeamNames] = useState({});
  const [showTeamNameModal, setShowTeamNameModal] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [streaks, setStreaks] = useState({
    Nicholas: 0,
    Emilie: 0,
    Carter: 0,
    Cole: 0,
    Finn: 0,
    Liam: 0
  });
  const [dailyCompletionHistory, setDailyCompletionHistory] = useState({});

  useEffect(() => {
    if (currentUser) {
      generateAssignments(viewDate);
      updateStreaks();
      checkMonthReset();
    }
  }, [currentUser, viewDate, customTasks]);

  const generateAssignments = (date) => {
    const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
    const dateKey = date.toISOString().split('T')[0];
    const newAssignments = {};

    const olderKids = ['Nicholas', 'Emilie', 'Carter', 'Cole'];
    const dailyPattern = DAILY_CHORES_ROTATION[dayName];
    
    olderKids.forEach((kid, index) => {
      if (!newAssignments[kid]) newAssignments[kid] = [];
      
      const chorePattern = dailyPattern[index];
      
      // Add zone chore if exists
      if (chorePattern.zone) {
        const zoneChoreId = `${kid}-zone-${dateKey}`;
        newAssignments[kid].push({
          id: zoneChoreId,
          chore: chorePattern.zone,
          type: 'zone',
          completed: completionData[zoneChoreId] || false,
          date: date.toISOString(),
          isCustom: false,
          note: choreNotes[zoneChoreId] || ''
        });
      }
      
      // Add dinner chore (always exists)
      const dinnerChoreId = `${kid}-dinner-${dateKey}`;
      newAssignments[kid].push({
        id: dinnerChoreId,
        chore: chorePattern.dinner,
        type: 'dinner',
        completed: completionData[dinnerChoreId] || false,
        date: date.toISOString(),
        isCustom: false,
        note: choreNotes[dinnerChoreId] || ''
      });
    });

    const dayOfWeek = date.getDay();
    const finnChores = dayOfWeek % 2 === 0 
      ? ['Set Table', 'Clean Stairs'] 
      : ['Help with Dishes', 'Clean Upstairs Hallway'];
    const liamChores = dayOfWeek % 2 === 0 
      ? ['Help with Dishes', 'Clean Upstairs Hallway'] 
      : ['Set Table', 'Clean Stairs'];

    newAssignments['Finn'] = finnChores.map((chore, i) => {
      const choreId = `Finn-daily-${dateKey}-${i}`;
      return {
        id: choreId,
        chore,
        type: 'daily',
        completed: completionData[choreId] || false,
        date: date.toISOString(),
        isCustom: false,
        note: choreNotes[choreId] || ''
      };
    });

    newAssignments['Liam'] = liamChores.map((chore, i) => {
      const choreId = `Liam-daily-${dateKey}-${i}`;
      return {
        id: choreId,
        chore,
        type: 'daily',
        completed: completionData[choreId] || false,
        date: date.toISOString(),
        isCustom: false,
        note: choreNotes[choreId] || ''
      };
    });

    const weeksSinceStart = Math.floor((date - WEEKLY_ROTATION_START.date) / (7 * 24 * 60 * 60 * 1000));
    const rotationOffset = weeksSinceStart % 6;
    
    const allKids = ['Nicholas', 'Emilie', 'Carter', 'Cole', 'Finn', 'Liam'];
    WEEKLY_CHORES.forEach((chore, choreIndex) => {
      const kidIndex = (choreIndex + rotationOffset) % 6;
      const assignedKid = allKids[kidIndex];
      
      if (!newAssignments[assignedKid]) newAssignments[assignedKid] = [];
      
      let choreName = chore;
      if (chore === 'Take Trash/Recycle to Curb') {
        choreName += ' (Recycle Week)';
      }
      
      const choreId = `${assignedKid}-weekly-${dateKey}-${chore}`;
      newAssignments[assignedKid].push({
        id: choreId,
        chore: choreName,
        type: 'weekly',
        completed: completionData[choreId] || false,
        date: date.toISOString(),
        isCustom: false,
        note: choreNotes[choreId] || ''
      });
    });

    // Add custom tasks for this date
    Object.values(customTasks).forEach(task => {
      const taskStart = new Date(task.startDate);
      const taskDue = new Date(task.dueDate);
      const currentDate = new Date(dateKey);
      
      // Check if current date is within the task's date range
      if (currentDate >= taskStart && currentDate <= taskDue) {
        if (!newAssignments[task.kid]) newAssignments[task.kid] = [];
        
        // Check if task is due today
        const isDueToday = currentDate.toISOString().split('T')[0] === task.dueDate;
        
        newAssignments[task.kid].push({
          id: task.id,
          chore: task.description,
          type: 'custom',
          completed: completionData[task.id] || false,
          date: date.toISOString(),
          isCustom: true,
          note: task.note || '',
          points: task.points || 10,
          dueDate: task.dueDate,
          isDueToday: isDueToday
        });
      }
    });

    setAssignments(newAssignments);
  };

  const handleLogin = () => {
    const user = INITIAL_STATE.users.find(
      u => u.name === loginForm.name && u.password === loginForm.password
    );
    if (user) {
      setCurrentUser(user);
    } else {
      alert('Invalid login');
    }
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setLoginForm({ name: '', password: '' });
  };

  const checkMonthReset = () => {
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();
    
    if (month !== currentMonth || year !== currentYear) {
      // New month! Reset monthly points
      setMonthlyPoints({
        Nicholas: 0,
        Emilie: 0,
        Carter: 0,
        Cole: 0,
        Finn: 0,
        Liam: 0
      });
      setCurrentMonth(month);
      setCurrentYear(year);
    }
  };

  const toggleChoreComplete = (kidName, choreId) => {
    // Check if we're viewing a future date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const viewing = new Date(viewDate);
    viewing.setHours(0, 0, 0, 0);
    
    if (viewing > today) {
      alert("You can't complete chores for future days yet!");
      return;
    }
    
    const wasCompleted = completionData[choreId];
    const newCompletionState = !wasCompleted;
    
    setCompletionData(prev => ({
      ...prev,
      [choreId]: newCompletionState
    }));
    
    // Update points
    if (newCompletionState) {
      const chore = assignments[kidName]?.find(c => c.id === choreId);
      if (chore) {
        const points = chore.points || CHORE_POINTS[chore.type] || 5;
        setUserPoints(prev => ({
          ...prev,
          [kidName]: prev[kidName] + points
        }));
        setMonthlyPoints(prev => ({
          ...prev,
          [kidName]: prev[kidName] + points
        }));
      }
    } else {
      const chore = assignments[kidName]?.find(c => c.id === choreId);
      if (chore) {
        const points = chore.points || CHORE_POINTS[chore.type] || 5;
        setUserPoints(prev => ({
          ...prev,
          [kidName]: Math.max(0, prev[kidName] - points)
        }));
        setMonthlyPoints(prev => ({
          ...prev,
          [kidName]: Math.max(0, prev[kidName] - points)
        }));
      }
    }
    
    setAssignments(prev => ({
      ...prev,
      [kidName]: prev[kidName].map(chore =>
        chore.id === choreId ? { ...chore, completed: newCompletionState } : chore
      )
    }));
  };

  const goToPreviousDay = () => {
    const newDate = new Date(viewDate);
    newDate.setDate(newDate.getDate() - 1);
    setViewDate(newDate);
  };

  const goToNextDay = () => {
    const newDate = new Date(viewDate);
    newDate.setDate(newDate.getDate() + 1);
    setViewDate(newDate);
  };

  const goToToday = () => {
    setViewDate(new Date());
  };

  const goToPreviousWeek = () => {
    const newDate = new Date(viewDate);
    newDate.setDate(newDate.getDate() - 7);
    setViewDate(newDate);
  };

  const goToNextWeek = () => {
    const newDate = new Date(viewDate);
    newDate.setDate(newDate.getDate() + 7);
    setViewDate(newDate);
  };

  const isToday = () => {
    const today = new Date();
    return viewDate.toDateString() === today.toDateString();
  };

  const getCompetitionWeek = () => {
    const competitionStart = new Date('2025-10-20'); // Start date for competitions
    const diffTime = viewDate - competitionStart;
    const diffWeeks = Math.floor(diffTime / (7 * 24 * 60 * 60 * 1000));
    return diffWeeks % 2 === 0 ? 'individual' : 'team';
  };

  const getCurrentTeams = () => {
    const competitionStart = new Date('2025-10-20');
    const diffTime = viewDate - competitionStart;
    const diffWeeks = Math.floor(diffTime / (7 * 24 * 60 * 60 * 1000));
    
    // Only rotate teams during team weeks (odd weeks)
    if (diffWeeks % 2 === 0) {
      // Individual week, return default teams
      return TEAMS;
    }
    
    // Team week - rotate through team configurations
    const teamWeekNumber = Math.floor(diffWeeks / 2);
    const rotationIndex = teamWeekNumber % TEAM_ROTATIONS.length;
    return TEAM_ROTATIONS[rotationIndex];
  };

  const getTeamWeekKey = () => {
    const competitionStart = new Date('2025-10-20');
    const diffTime = viewDate - competitionStart;
    const diffWeeks = Math.floor(diffTime / (7 * 24 * 60 * 60 * 1000));
    const teamWeekNumber = Math.floor(diffWeeks / 2);
    const rotationIndex = teamWeekNumber % TEAM_ROTATIONS.length;
    return `week-${diffWeeks}-rotation-${rotationIndex}`;
  };

  const getTeamName = (team) => {
    const weekKey = getTeamWeekKey();
    const savedName = teamNames[`${weekKey}-${team}`];
    return savedName || `Team ${team === 'Team1' ? '1' : '2'}`;
  };

  const isTeamCaptain = (kidName, team) => {
    const currentTeams = getCurrentTeams();
    return currentTeams.captains && currentTeams.captains[team] === kidName;
  };

  const handleSetTeamName = () => {
    if (!newTeamName.trim()) {
      alert('Please enter a team name');
      return;
    }
    
    const weekKey = getTeamWeekKey();
    const team = myTeam;
    
    setTeamNames(prev => ({
      ...prev,
      [`${weekKey}-${team}`]: newTeamName.trim()
    }));
    
    setNewTeamName('');
    setShowTeamNameModal(false);
  };

  const getTeamPoints = () => {
    const currentTeams = getCurrentTeams();
    const team1Points = currentTeams.Team1.reduce((sum, kid) => sum + (monthlyPoints[kid] || 0), 0);
    const team2Points = currentTeams.Team2.reduce((sum, kid) => sum + (monthlyPoints[kid] || 0), 0);
    return { Team1: team1Points, Team2: team2Points };
  };

  const getKidTeam = (kidName) => {
    const currentTeams = getCurrentTeams();
    if (currentTeams.Team1.includes(kidName)) return 'Team1';
    if (currentTeams.Team2.includes(kidName)) return 'Team2';
    return null;
  };

  const updateStreaks = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const allKids = ['Nicholas', 'Emilie', 'Carter', 'Cole', 'Finn', 'Liam'];
    const newStreaks = {};
    
    allKids.forEach(kid => {
      let streak = 0;
      let checkDate = new Date(today);
      checkDate.setDate(checkDate.getDate() - 1); // Start from yesterday
      
      // Check backwards day by day
      for (let i = 0; i < 365; i++) {
        const dateKey = checkDate.toISOString().split('T')[0];
        const dayChores = getDayChores(kid, checkDate);
        
        if (dayChores.length === 0) {
          // No chores assigned that day, skip it
          checkDate.setDate(checkDate.getDate() - 1);
          continue;
        }
        
        const allComplete = dayChores.every(chore => completionData[chore.id]);
        
        if (allComplete) {
          streak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
      
      newStreaks[kid] = streak;
    });
    
    setStreaks(newStreaks);
  };

  const getDayChores = (kidName, date) => {
    const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
    const dateKey = date.toISOString().split('T')[0];
    const dayChores = [];
    
    const olderKids = ['Nicholas', 'Emilie', 'Carter', 'Cole'];
    const youngerKids = ['Finn', 'Liam'];
    
    if (olderKids.includes(kidName)) {
      const kidIndex = olderKids.indexOf(kidName);
      const dailyPattern = DAILY_CHORES_ROTATION[dayName];
      const chorePattern = dailyPattern[kidIndex];
      
      if (chorePattern.zone) {
        dayChores.push({ id: `${kidName}-zone-${dateKey}`, type: 'zone' });
      }
      dayChores.push({ id: `${kidName}-dinner-${dateKey}`, type: 'dinner' });
    }
    
    if (youngerKids.includes(kidName)) {
      const dayOfWeek = date.getDay();
      const numChores = dayOfWeek % 2 === 0 ? 2 : 2;
      for (let i = 0; i < numChores; i++) {
        dayChores.push({ id: `${kidName}-daily-${dateKey}-${i}`, type: 'daily' });
      }
    }
    
    // Add weekly chores
    const weeksSinceStart = Math.floor((date - WEEKLY_ROTATION_START.date) / (7 * 24 * 60 * 60 * 1000));
    const rotationOffset = weeksSinceStart % 6;
    const allKids = ['Nicholas', 'Emilie', 'Carter', 'Cole', 'Finn', 'Liam'];
    
    WEEKLY_CHORES.forEach((chore, choreIndex) => {
      const kidIndex = (choreIndex + rotationOffset) % 6;
      const assignedKid = allKids[kidIndex];
      
      if (assignedKid === kidName) {
        dayChores.push({ id: `${kidName}-weekly-${dateKey}-${chore}`, type: 'weekly' });
      }
    });
    
    // Add custom tasks
    Object.values(customTasks).forEach(task => {
      if (task.kid === kidName) {
        const taskStart = new Date(task.startDate);
        const taskDue = new Date(task.dueDate);
        const currentDate = new Date(dateKey);
        
        // Check if current date is within the task's date range
        if (currentDate >= taskStart && currentDate <= taskDue) {
          dayChores.push({ id: task.id, type: 'custom' });
        }
      }
    });
    
    return dayChores;
  };

  const handleAddTask = () => {
    if (!newTask.kid || !newTask.description.trim()) {
      alert('Please select a kid and enter a task description');
      return;
    }
    
    if (!newTask.startDate || !newTask.dueDate) {
      alert('Please select both start and due dates');
      return;
    }
    
    const start = new Date(newTask.startDate);
    const due = new Date(newTask.dueDate);
    
    if (due < start) {
      alert('Due date must be after or equal to start date');
      return;
    }

    const taskId = `custom-${Date.now()}`;
    
    setCustomTasks(prev => ({
      ...prev,
      [taskId]: {
        id: taskId,
        kid: newTask.kid,
        description: newTask.description,
        note: newTask.note,
        points: parseInt(newTask.points) || 10,
        startDate: newTask.startDate,
        dueDate: newTask.dueDate
      }
    }));

    setNewTask({ kid: '', description: '', note: '', points: 10, startDate: '', dueDate: '' });
    setShowAddTaskModal(false);
  };

  const handleAddNote = () => {
    if (selectedChore && selectedChore.noteText.trim()) {
      setChoreNotes(prev => ({
        ...prev,
        [selectedChore.id]: selectedChore.noteText
      }));
    }
    setShowNoteModal(false);
    setSelectedChore(null);
  };

  const openNoteModal = (chore, kidName) => {
    setSelectedChore({
      id: chore.id,
      chore: chore.chore,
      kidName: kidName,
      noteText: chore.note || ''
    });
    setShowNoteModal(true);
  };

  const handleDeleteTask = (taskId) => {
    setCustomTasks(prev => {
      const newTasks = { ...prev };
      delete newTasks[taskId];
      return newTasks;
    });
  };

  if (!currentUser) {
    const kids = INITIAL_STATE.users.filter(u => u.role === 'child');
    const parents = INITIAL_STATE.users.filter(u => u.role === 'parent');

    // If a parent is selected in the form, show password input
    if (loginForm.name && INITIAL_STATE.users.find(u => u.name === loginForm.name)?.role === 'parent') {
      return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
            <div className="text-center mb-8">
              <Home className="w-16 h-16 mx-auto text-indigo-600 mb-4" />
              <h1 className="text-3xl font-bold text-gray-800">Parent Login</h1>
              <p className="text-gray-600 mt-2">Enter password for {loginForm.name}</p>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  autoFocus
                  onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
                />
              </div>
              
              <div className="flex gap-3">
                <button
                  onClick={() => setLoginForm({ name: '', password: '' })}
                  className="flex-1 px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleLogin}
                  className="flex-1 bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
                >
                  Sign In
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-2xl">
          <div className="text-center mb-8">
            <Home className="w-16 h-16 mx-auto text-indigo-600 mb-4" />
            <h1 className="text-3xl font-bold text-gray-800">Family Chores</h1>
            <p className="text-gray-600 mt-2">Who's checking in?</p>
          </div>
          
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-gray-700 mb-3">Kids</h2>
            <div className="grid grid-cols-2 gap-3">
              {kids.map(kid => (
                <button
                  key={kid.id}
                  onClick={() => {
                    setCurrentUser(kid);
                  }}
                  className="p-6 bg-gradient-to-br from-purple-50 to-pink-50 rounded-xl hover:shadow-lg transition-shadow border-2 border-transparent hover:border-purple-300"
                >
                  <div className="text-4xl mb-2">👤</div>
                  <p className="text-xl font-bold text-gray-800">{kid.name}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-gray-700 mb-3">Parents</h2>
            <div className="grid grid-cols-2 gap-3">
              {parents.map(parent => (
                <button
                  key={parent.id}
                  onClick={() => {
                    setLoginForm({ name: parent.name, password: '' });
                  }}
                  className="p-6 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl hover:shadow-lg transition-shadow border-2 border-transparent hover:border-indigo-300"
                >
                  <div className="text-4xl mb-2">🔒</div>
                  <p className="text-xl font-bold text-gray-800">{parent.name}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (currentUser.role === 'parent') {
    const dateKey = viewDate.toISOString().split('T')[0];
    const competitionType = getCompetitionWeek();
    const currentTeams = getCurrentTeams();
    const teamPoints = getTeamPoints();
    const monthName = new Date(currentYear, currentMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    
    // Generate leaderboard data
    const leaderboardData = Object.keys(userPoints)
      .map(kidName => ({
        name: kidName,
        points: userPoints[kidName],
        monthlyPoints: monthlyPoints[kidName],
        team: getKidTeam(kidName),
        streak: streaks[kidName] || 0,
        todayChores: assignments[kidName] || [],
        completedToday: (assignments[kidName] || []).filter(c => c.completed).length,
        totalToday: (assignments[kidName] || []).length
      }))
      .sort((a, b) => b.monthlyPoints - a.monthlyPoints);
    
    return (
      <div className="min-h-screen bg-gray-50">
        <header className="bg-white shadow-sm">
          <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <Users className="w-8 h-8 text-indigo-600" />
              <h1 className="text-2xl font-bold text-gray-800">Parent Dashboard</h1>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowAddTaskModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
              >
                <Plus className="w-5 h-5" />
                Add Task
              </button>
              <button
                onClick={() => setShowLeaderboard(true)}
                className="flex items-center gap-2 px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 transition-colors"
              >
                <Trophy className="w-5 h-5" />
                Leaderboard
              </button>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:text-gray-800"
              >
                <LogOut className="w-5 h-5" />
                Logout
              </button>
            </div>
          </div>
        </header>

        <main className="max-w-7xl mx-auto px-4 py-8">
          <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={goToPreviousDay}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                  title="Previous Day"
                >
                  <ChevronLeft className="w-6 h-6 text-gray-600" />
                </button>
                <div className="flex items-center gap-2">
                  <Calendar className="w-6 h-6 text-indigo-600" />
                  <h2 className="text-xl font-semibold">
                    {viewDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                  </h2>
                </div>
                <button
                  onClick={goToNextDay}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                  title="Next Day"
                >
                  <ChevronRight className="w-6 h-6 text-gray-600" />
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={goToPreviousWeek}
                  className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm"
                  title="Previous Week"
                >
                  ← Week
                </button>
                <button
                  onClick={goToNextWeek}
                  className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm"
                  title="Next Week"
                >
                  Week →
                </button>
                {!isToday() && (
                  <button
                    onClick={goToToday}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                  >
                    Today
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-6">
            {Object.entries(assignments).map(([kidName, chores]) => {
              const zoneChores = chores.filter(c => c.type === 'zone');
              const dinnerChores = chores.filter(c => c.type === 'dinner');
              const dailyChores = chores.filter(c => c.type === 'daily');
              const weeklyChores = chores.filter(c => c.type === 'weekly');
              const customChores = chores.filter(c => c.type === 'custom');
              
              return (
                <div key={kidName} className="bg-white rounded-lg shadow-sm p-6">
                  <h3 className="text-xl font-bold text-gray-800 mb-4">{kidName}</h3>
                  
                  {zoneChores.length > 0 && (
                    <div className="mb-4">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                        <h4 className="font-semibold text-green-700">Zone Jobs</h4>
                      </div>
                      <div className="space-y-2">
                        {zoneChores.map(chore => (
                          <div key={chore.id} className="flex items-center gap-3 p-3 bg-green-50 rounded-lg border-l-4 border-green-500">
                            <button
                              onClick={() => toggleChoreComplete(kidName, chore.id)}
                              className="flex-shrink-0"
                            >
                              {chore.completed ? (
                                <CheckCircle2 className="w-6 h-6 text-green-500" />
                              ) : (
                                <Circle className="w-6 h-6 text-gray-400" />
                              )}
                            </button>
                            <div className="flex-1">
                              <p className={`font-medium ${chore.completed ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                                {chore.chore}
                              </p>
                              {chore.note && (
                                <div className="mt-1 flex items-start gap-1 text-sm text-green-700 bg-green-100 p-2 rounded">
                                  <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                  <span>{chore.note}</span>
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => openNoteModal(chore, kidName)}
                              className="flex-shrink-0 p-2 hover:bg-green-100 rounded transition-colors"
                              title="Add/Edit Note"
                            >
                              <FileText className="w-5 h-5 text-green-600" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {dinnerChores.length > 0 && (
                    <div className="mb-4">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-3 h-3 bg-amber-500 rounded-full"></div>
                        <h4 className="font-semibold text-amber-700">After Dinner Jobs</h4>
                      </div>
                      <div className="space-y-2">
                        {dinnerChores.map(chore => (
                          <div key={chore.id} className="flex items-center gap-3 p-3 bg-amber-50 rounded-lg border-l-4 border-amber-500">
                            <button
                              onClick={() => toggleChoreComplete(kidName, chore.id)}
                              className="flex-shrink-0"
                            >
                              {chore.completed ? (
                                <CheckCircle2 className="w-6 h-6 text-green-500" />
                              ) : (
                                <Circle className="w-6 h-6 text-gray-400" />
                              )}
                            </button>
                            <div className="flex-1">
                              <p className={`font-medium ${chore.completed ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                                {chore.chore}
                              </p>
                              {chore.note && (
                                <div className="mt-1 flex items-start gap-1 text-sm text-amber-700 bg-amber-100 p-2 rounded">
                                  <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                  <span>{chore.note}</span>
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => openNoteModal(chore, kidName)}
                              className="flex-shrink-0 p-2 hover:bg-amber-100 rounded transition-colors"
                              title="Add/Edit Note"
                            >
                              <FileText className="w-5 h-5 text-amber-600" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {dailyChores.length > 0 && (
                    <div className="mb-4">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
                        <h4 className="font-semibold text-blue-700">Daily Chores</h4>
                      </div>
                      <div className="space-y-2">
                        {dailyChores.map(chore => (
                          <div key={chore.id} className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg border-l-4 border-blue-500">
                            <button
                              onClick={() => toggleChoreComplete(kidName, chore.id)}
                              className="flex-shrink-0"
                            >
                              {chore.completed ? (
                                <CheckCircle2 className="w-6 h-6 text-green-500" />
                              ) : (
                                <Circle className="w-6 h-6 text-gray-400" />
                              )}
                            </button>
                            <div className="flex-1">
                              <p className={`font-medium ${chore.completed ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                                {chore.chore}
                              </p>
                              {chore.note && (
                                <div className="mt-1 flex items-start gap-1 text-sm text-blue-700 bg-blue-100 p-2 rounded">
                                  <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                  <span>{chore.note}</span>
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => openNoteModal(chore, kidName)}
                              className="flex-shrink-0 p-2 hover:bg-blue-100 rounded transition-colors"
                              title="Add/Edit Note"
                            >
                              <FileText className="w-5 h-5 text-blue-600" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {weeklyChores.length > 0 && (
                    <div className="mb-4">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-3 h-3 bg-purple-500 rounded-full"></div>
                        <h4 className="font-semibold text-purple-700">Weekly Chores</h4>
                        <span className="text-xs text-purple-600 bg-purple-100 px-2 py-1 rounded">Due by Wednesday EOD</span>
                      </div>
                      <div className="space-y-2">
                        {weeklyChores.map(chore => (
                          <div key={chore.id} className="flex items-center gap-3 p-3 bg-purple-50 rounded-lg border-l-4 border-purple-500">
                            <button
                              onClick={() => toggleChoreComplete(kidName, chore.id)}
                              className="flex-shrink-0"
                            >
                              {chore.completed ? (
                                <CheckCircle2 className="w-6 h-6 text-green-500" />
                              ) : (
                                <Circle className="w-6 h-6 text-gray-400" />
                              )}
                            </button>
                            <div className="flex-1">
                              <p className={`font-medium ${chore.completed ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                                {chore.chore}
                              </p>
                              {chore.note && (
                                <div className="mt-1 flex items-start gap-1 text-sm text-purple-700 bg-purple-100 p-2 rounded">
                                  <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                  <span>{chore.note}</span>
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => openNoteModal(chore, kidName)}
                              className="flex-shrink-0 p-2 hover:bg-purple-100 rounded transition-colors"
                              title="Add/Edit Note"
                            >
                              <FileText className="w-5 h-5 text-purple-600" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {customChores.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-3 h-3 bg-orange-500 rounded-full"></div>
                        <h4 className="font-semibold text-orange-700">Additional Jobs</h4>
                      </div>
                      <div className="space-y-2">
                        {customChores.map(chore => (
                          <div key={chore.id} className="flex items-center gap-3 p-3 bg-orange-50 rounded-lg border-l-4 border-orange-500">
                            <button
                              onClick={() => toggleChoreComplete(kidName, chore.id)}
                              className="flex-shrink-0"
                            >
                              {chore.completed ? (
                                <CheckCircle2 className="w-6 h-6 text-green-500" />
                              ) : (
                                <Circle className="w-6 h-6 text-gray-400" />
                              )}
                            </button>
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <p className={`font-medium ${chore.completed ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                                  {chore.chore}
                                </p>
                                <span className="text-xs font-bold text-orange-600 bg-orange-100 px-2 py-0.5 rounded">
                                  +{chore.points || 10} pts
                                </span>
                              </div>
                              {chore.note && (
                                <div className="mt-1 flex items-start gap-1 text-sm text-orange-700 bg-orange-100 p-2 rounded">
                                  <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                  <span>{chore.note}</span>
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => handleDeleteTask(chore.id, dateKey)}
                              className="flex-shrink-0 p-1 hover:bg-red-100 rounded transition-colors"
                            >
                              <X className="w-5 h-5 text-red-500" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </main>

        {showAddTaskModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
              <div className="flex items-center justify-between p-4 border-b border-gray-200">
                <h3 className="text-lg font-bold text-gray-800">Add Custom Task</h3>
                <button
                  onClick={() => {
                    setShowAddTaskModal(false);
                    setNewTask({ kid: '', description: '', note: '', points: 10, startDate: '', dueDate: '' });
                  }}
                  className="p-1 hover:bg-gray-100 rounded transition-colors"
                >
                  <X className="w-5 h-5 text-gray-600" />
                </button>
              </div>

              <div className="overflow-y-auto p-4 space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Assign to</label>
                  <select
                    value={newTask.kid}
                    onChange={(e) => setNewTask({ ...newTask, kid: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  >
                    <option value="">Select a kid</option>
                    <option value="Nicholas">Nicholas</option>
                    <option value="Emilie">Emilie</option>
                    <option value="Carter">Carter</option>
                    <option value="Cole">Cole</option>
                    <option value="Finn">Finn</option>
                    <option value="Liam">Liam</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Task Description</label>
                  <input
                    type="text"
                    value={newTask.description}
                    onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                    placeholder="e.g., Clean out garage, Wash car"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Instructions (Optional)</label>
                  <textarea
                    value={newTask.note}
                    onChange={(e) => setNewTask({ ...newTask, note: e.target.value })}
                    placeholder="Add any special instructions or details..."
                    rows="2"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Points Value</label>
                  <input
                    type="number"
                    value={newTask.points}
                    onChange={(e) => setNewTask({ ...newTask, points: e.target.value })}
                    min="1"
                    max="50"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                  <p className="text-xs text-gray-500 mt-0.5">How many points is this job worth?</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
                    <input
                      type="date"
                      value={newTask.startDate}
                      onChange={(e) => setNewTask({ ...newTask, startDate: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    />
                    <p className="text-xs text-gray-500 mt-0.5">When it appears</p>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
                    <input
                      type="date"
                      value={newTask.dueDate}
                      onChange={(e) => setNewTask({ ...newTask, dueDate: e.target.value })}
                      min={newTask.startDate}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    />
                    <p className="text-xs text-gray-500 mt-0.5">Must be done by</p>
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-200 p-4">
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setShowAddTaskModal(false);
                      setNewTask({ kid: '', description: '', note: '', points: 10, startDate: '', dueDate: '' });
                    }}
                    className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddTask}
                    className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                  >
                    Add Job
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showNoteModal && selectedChore && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-bold text-gray-800">Add Instructions</h3>
                <button
                  onClick={() => {
                    setShowNoteModal(false);
                    setSelectedChore(null);
                  }}
                  className="p-1 hover:bg-gray-100 rounded transition-colors"
                >
                  <X className="w-6 h-6 text-gray-600" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-1">Task</p>
                  <p className="text-gray-900 font-semibold">{selectedChore.chore}</p>
                  <p className="text-sm text-gray-500">For: {selectedChore.kidName}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Instructions</label>
                  <textarea
                    value={selectedChore.noteText}
                    onChange={(e) => setSelectedChore({ ...selectedChore, noteText: e.target.value })}
                    placeholder="Add instructions on how to do this task..."
                    rows="4"
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
                  />
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setShowNoteModal(false);
                      setSelectedChore(null);
                    }}
                    className="flex-1 px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddNote}
                    className="flex-1 px-4 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                  >
                    Save Note
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showLeaderboard && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Trophy className="w-8 h-8 text-yellow-500" />
                  <h3 className="text-2xl font-bold text-gray-800">Leaderboard</h3>
                </div>
                <button
                  onClick={() => setShowLeaderboard(false)}
                  className="p-1 hover:bg-gray-100 rounded transition-colors"
                >
                  <X className="w-6 h-6 text-gray-600" />
                </button>
              </div>

              <div className="mb-4 p-3 bg-gradient-to-r from-indigo-100 to-purple-100 rounded-lg text-center">
                <p className="text-sm font-semibold text-indigo-700">
                  📅 {monthName} Competition
                </p>
                <p className="text-xs text-indigo-600 mt-1">
                  {competitionType === 'individual' 
                    ? 'Individual competition this week' 
                    : 'Team competition this week'}
                </p>
              </div>

              {competitionType === 'team' && (
                <div className="mb-4 grid grid-cols-2 gap-3">
                  <div className={`p-4 rounded-xl text-center ${
                    teamPoints.Team1 > teamPoints.Team2 
                      ? 'bg-gradient-to-br from-yellow-100 to-yellow-50 border-2 border-yellow-400' 
                      : 'bg-gray-50 border-2 border-gray-200'
                  }`}>
                    <p className="text-sm font-semibold text-gray-700">{getTeamName('Team1')}</p>
                    <p className="text-xs text-gray-600 mb-1">
                      {currentTeams.Team1.map(k => k.split(' ')[0]).join(', ')}
                    </p>
                    {currentTeams.captains && (
                      <p className="text-xs text-indigo-600 mb-1">
                        👑 Captain: {currentTeams.captains.Team1}
                      </p>
                    )}
                    <p className="text-3xl font-bold text-indigo-600">{teamPoints.Team1}</p>
                    <p className="text-xs text-gray-500">points</p>
                  </div>
                  <div className={`p-4 rounded-xl text-center ${
                    teamPoints.Team2 > teamPoints.Team1 
                      ? 'bg-gradient-to-br from-yellow-100 to-yellow-50 border-2 border-yellow-400' 
                      : 'bg-gray-50 border-2 border-gray-200'
                  }`}>
                    <p className="text-sm font-semibold text-gray-700">{getTeamName('Team2')}</p>
                    <p className="text-xs text-gray-600 mb-1">
                      {currentTeams.Team2.map(k => k.split(' ')[0]).join(', ')}
                    </p>
                    {currentTeams.captains && (
                      <p className="text-xs text-indigo-600 mb-1">
                        👑 Captain: {currentTeams.captains.Team2}
                      </p>
                    )}
                    <p className="text-3xl font-bold text-indigo-600">{teamPoints.Team2}</p>
                    <p className="text-xs text-gray-500">points</p>
                  </div>
                </div>
              )}

              <p className="text-sm font-semibold text-gray-700 mb-3">Individual Stats</p>
              <div className="space-y-3">
                {leaderboardData.map((kid, index) => (
                  <div 
                    key={kid.name}
                    className={`p-4 rounded-xl ${
                      competitionType === 'individual' ? (
                        index === 0 ? 'bg-gradient-to-r from-yellow-100 to-yellow-50 border-2 border-yellow-400' :
                        index === 1 ? 'bg-gradient-to-r from-gray-100 to-gray-50 border-2 border-gray-300' :
                        index === 2 ? 'bg-gradient-to-r from-orange-100 to-orange-50 border-2 border-orange-300' :
                        'bg-gray-50'
                      ) : (
                        kid.team === 'Team1' ? 'bg-blue-50 border-l-4 border-blue-500' :
                        'bg-green-50 border-l-4 border-green-500'
                      )
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {competitionType === 'individual' && (
                          <div className={`text-2xl font-bold ${
                            index === 0 ? 'text-yellow-600' :
                            index === 1 ? 'text-gray-600' :
                            index === 2 ? 'text-orange-600' :
                            'text-gray-400'
                          }`}>
                            {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`}
                          </div>
                        )}
                        <div>
                          <p className="font-bold text-gray-800">
                            {kid.name}
                            {competitionType === 'team' && (
                              <span className={`ml-2 text-xs px-2 py-0.5 rounded ${
                                kid.team === 'Team1' ? 'bg-blue-200 text-blue-700' : 'bg-green-200 text-green-700'
                              }`}>
                                {kid.team === 'Team1' ? 'Team 1' : 'Team 2'}
                              </span>
                            )}
                          </p>
                          <div className="flex items-center gap-3 text-sm text-gray-600">
                            <span>Today: {kid.completedToday}/{kid.totalToday}</span>
                            {kid.streak > 0 && (
                              <span className="flex items-center gap-1 text-orange-600 font-semibold">
                                🔥 {kid.streak} day{kid.streak !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-indigo-600">{kid.monthlyPoints}</p>
                        <p className="text-xs text-gray-500">this month</p>
                        <p className="text-xs text-gray-400">{kid.points} all-time</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={() => setShowLeaderboard(false)}
                className="w-full mt-6 px-4 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const myChores = assignments[currentUser.name] || [];
  const completedCount = myChores.filter(c => c.completed).length;
  const totalPoints = userPoints[currentUser.name] || 0;
  const monthlyPointsTotal = monthlyPoints[currentUser.name] || 0;
  const todaysPotentialPoints = myChores.reduce((sum, chore) => 
    sum + (chore.points || CHORE_POINTS[chore.type] || 5), 0
  );

  const competitionType = getCompetitionWeek();
  const myTeam = getKidTeam(currentUser.name);
  const currentTeams = getCurrentTeams();
  const teamPoints = getTeamPoints();
  const myStreak = streaks[currentUser.name] || 0;
  const monthName = new Date(currentYear, currentMonth).toLocaleDateString('en-US', { month: 'long' });

  // Generate leaderboard data for kids view
  const leaderboardData = Object.keys(userPoints)
    .map(kidName => ({
      name: kidName,
      points: userPoints[kidName],
      monthlyPoints: monthlyPoints[kidName],
      team: getKidTeam(kidName),
      streak: streaks[kidName] || 0
    }))
    .sort((a, b) => b.monthlyPoints - a.monthlyPoints);
  const myRank = leaderboardData.findIndex(k => k.name === currentUser.name) + 1;

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Hi, {currentUser.name}! 👋</h1>
            <p className="text-gray-600">{viewDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowLeaderboard(true)}
              className="flex items-center gap-2 px-3 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 transition-colors"
            >
              <Trophy className="w-5 h-5" />
              {competitionType === 'individual' ? (
                <>
                  <span className="hidden sm:inline">Rank #{myRank}</span>
                  <span className="sm:hidden">#{myRank}</span>
                </>
              ) : (
                <>
                  <span className="hidden sm:inline">{getTeamName(myTeam)}</span>
                  <span className="sm:hidden">{myTeam === 'Team1' ? 'T1' : 'T2'}</span>
                </>
              )}
            </button>
            {competitionType === 'team' && isTeamCaptain(currentUser.name, myTeam) && (
              <button
                onClick={() => setShowTeamNameModal(true)}
                className="px-3 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors text-sm"
              >
                👑 Name Team
              </button>
            )}
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 px-3 py-2 text-gray-600 hover:text-gray-800"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="bg-gradient-to-r from-indigo-500 to-purple-600 rounded-2xl shadow-lg p-6 mb-6 text-white">
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <p className="text-indigo-100 text-xs">This Month</p>
              <p className="text-2xl font-bold">🏆 {monthlyPointsTotal}</p>
              <p className="text-xs text-indigo-200">{monthName}</p>
            </div>
            <div>
              <p className="text-indigo-100 text-xs">Streak</p>
              <p className="text-2xl font-bold">🔥 {myStreak}</p>
              <p className="text-xs text-indigo-200">day{myStreak !== 1 ? 's' : ''}</p>
            </div>
            <div>
              <p className="text-indigo-100 text-xs">All-Time</p>
              <p className="text-2xl font-bold">⭐ {totalPoints}</p>
              <p className="text-xs text-indigo-200">total</p>
            </div>
          </div>
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={goToPreviousDay}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
              title="Previous Day"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="flex-1 bg-white/20 rounded-full h-3 overflow-hidden">
              <div 
                className="bg-white h-full rounded-full transition-all duration-300"
                style={{ width: `${myChores.length > 0 ? (completedCount / myChores.length) * 100 : 0}%` }}
              />
            </div>
            <button
              onClick={goToNextDay}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
              title="Next Day"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-indigo-100 text-sm">{completedCount} of {myChores.length} completed</p>
            <p className="text-indigo-100 text-sm">+{todaysPotentialPoints} pts possible</p>
            <div className="flex gap-2">
              <button
                onClick={goToPreviousWeek}
                className="px-2 py-1 bg-white/20 hover:bg-white/30 rounded text-xs transition-colors"
                title="Previous Week"
              >
                ← Week
              </button>
              <button
                onClick={goToNextWeek}
                className="px-2 py-1 bg-white/20 hover:bg-white/30 rounded text-xs transition-colors"
                title="Next Week"
              >
                Week →
              </button>
              {!isToday() && (
                <button
                  onClick={goToToday}
                  className="px-2 py-1 bg-white text-indigo-600 rounded text-xs font-semibold hover:bg-indigo-50 transition-colors"
                >
                  Today
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {myChores.filter(c => !c.completed).length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-700 mb-3">To Do</h2>
              
              {myChores.filter(c => !c.completed && c.type === 'zone').length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                    <p className="text-sm font-semibold text-green-700">Zone Jobs</p>
                    <span className="text-xs text-green-600 bg-green-100 px-2 py-0.5 rounded">+5 pts each</span>
                  </div>
                  {myChores.filter(c => !c.completed && c.type === 'zone').map(chore => (
                    <button
                      key={chore.id}
                      onClick={() => toggleChoreComplete(currentUser.name, chore.id)}
                      className="w-full bg-green-50 rounded-xl shadow-sm p-4 mb-2 flex items-start gap-4 hover:shadow-md transition-shadow border-l-4 border-green-500 text-left"
                    >
                      <Circle className="w-8 h-8 text-green-400 flex-shrink-0 mt-1" />
                      <div className="flex-1">
                        <p className="font-semibold text-gray-800">{chore.chore}</p>
                        {chore.note && (
                          <div className="mt-2 flex items-start gap-1 text-sm text-green-700 bg-green-100 p-2 rounded">
                            <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <span>{chore.note}</span>
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              
              {myChores.filter(c => !c.completed && c.type === 'dinner').length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 bg-amber-500 rounded-full"></div>
                    <p className="text-sm font-semibold text-amber-700">After Dinner Jobs</p>
                  </div>
                  {myChores.filter(c => !c.completed && c.type === 'dinner').map(chore => (
                    <button
                      key={chore.id}
                      onClick={() => toggleChoreComplete(currentUser.name, chore.id)}
                      className="w-full bg-amber-50 rounded-xl shadow-sm p-4 mb-2 flex items-start gap-4 hover:shadow-md transition-shadow border-l-4 border-amber-500 text-left"
                    >
                      <Circle className="w-8 h-8 text-amber-400 flex-shrink-0 mt-1" />
                      <div className="flex-1">
                        <p className="font-semibold text-gray-800">{chore.chore}</p>
                        {chore.note && (
                          <div className="mt-2 flex items-start gap-1 text-sm text-amber-700 bg-amber-100 p-2 rounded">
                            <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <span>{chore.note}</span>
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              
              {myChores.filter(c => !c.completed && c.type === 'daily').length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                    <p className="text-sm font-semibold text-blue-700">Daily</p>
                    <span className="text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded">+3 pts each</span>
                  </div>
                  {myChores.filter(c => !c.completed && c.type === 'daily').map(chore => (
                    <button
                      key={chore.id}
                      onClick={() => toggleChoreComplete(currentUser.name, chore.id)}
                      className="w-full bg-blue-50 rounded-xl shadow-sm p-4 mb-2 flex items-start gap-4 hover:shadow-md transition-shadow border-l-4 border-blue-500 text-left"
                    >
                      <Circle className="w-8 h-8 text-blue-400 flex-shrink-0 mt-1" />
                      <div className="flex-1">
                        <p className="font-semibold text-gray-800">{chore.chore}</p>
                        {chore.note && (
                          <div className="mt-2 flex items-start gap-1 text-sm text-blue-700 bg-blue-100 p-2 rounded">
                            <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <span>{chore.note}</span>
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              
              {myChores.filter(c => !c.completed && c.type === 'weekly').length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                    <p className="text-sm font-semibold text-purple-700">Weekly</p>
                    <span className="text-xs text-purple-600 bg-purple-100 px-2 py-0.5 rounded">+10 pts</span>
                    <span className="text-xs text-purple-600 bg-purple-100 px-2 py-0.5 rounded">Due Wed.</span>
                  </div>
                  {myChores.filter(c => !c.completed && c.type === 'weekly').map(chore => (
                    <button
                      key={chore.id}
                      onClick={() => toggleChoreComplete(currentUser.name, chore.id)}
                      className="w-full bg-purple-50 rounded-xl shadow-sm p-4 mb-2 flex items-start gap-4 hover:shadow-md transition-shadow border-l-4 border-purple-500 text-left"
                    >
                      <Circle className="w-8 h-8 text-purple-400 flex-shrink-0 mt-1" />
                      <div className="flex-1">
                        <p className="font-semibold text-gray-800">{chore.chore}</p>
                        {chore.note && (
                          <div className="mt-2 flex items-start gap-1 text-sm text-purple-700 bg-purple-100 p-2 rounded">
                            <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <span>{chore.note}</span>
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              
              {myChores.filter(c => !c.completed && c.type === 'custom').length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 bg-orange-500 rounded-full"></div>
                    <p className="text-sm font-semibold text-orange-700">Additional Jobs</p>
                  </div>
                  {myChores.filter(c => !c.completed && c.type === 'custom').map(chore => (
                    <button
                      key={chore.id}
                      onClick={() => toggleChoreComplete(currentUser.name, chore.id)}
                      className="w-full bg-orange-50 rounded-xl shadow-sm p-4 mb-2 flex items-start gap-4 hover:shadow-md transition-shadow border-l-4 border-orange-500 text-left"
                    >
                      <Circle className="w-8 h-8 text-orange-400 flex-shrink-0 mt-1" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="font-semibold text-gray-800">{chore.chore}</p>
                          <span className="text-xs font-bold text-orange-600 bg-orange-200 px-2 py-0.5 rounded">
                            +{chore.points || 10} pts
                          </span>
                          {chore.dueDate && (
                            <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                              chore.isDueToday 
                                ? 'text-red-700 bg-red-200' 
                                : 'text-gray-600 bg-gray-200'
                            }`}>
                              {chore.isDueToday ? '⏰ Due Today!' : `Due ${new Date(chore.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                            </span>
                          )}
                        </div>
                        {chore.note && (
                          <div className="mt-2 flex items-start gap-1 text-sm text-orange-700 bg-orange-100 p-2 rounded">
                            <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <span>{chore.note}</span>
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {myChores.filter(c => c.completed).length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-700 mb-3">Completed ✨</h2>
              {myChores.filter(c => c.completed).map(chore => (
                <button
                  key={chore.id}
                  onClick={() => toggleChoreComplete(currentUser.name, chore.id)}
                  className="w-full bg-green-50 rounded-xl shadow-sm p-4 mb-3 flex items-center gap-4"
                >
                  <CheckCircle2 className="w-8 h-8 text-green-500 flex-shrink-0" />
                  <div className="text-left flex-1">
                    <p className="font-semibold text-gray-400 line-through">{chore.chore}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>

      {showLeaderboard && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[75vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <Trophy className="w-6 h-6 text-yellow-500" />
                <h3 className="text-lg font-bold text-gray-800">Leaderboard</h3>
              </div>
              <button
                onClick={() => setShowLeaderboard(false)}
                className="p-1 hover:bg-gray-100 rounded transition-colors"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="overflow-y-auto p-4 space-y-3">
            <div className="p-2 bg-gradient-to-r from-indigo-100 to-purple-100 rounded-lg text-center">
              <p className="text-xs font-semibold text-indigo-700">
                📅 {monthName} Competition
              </p>
              <p className="text-xs text-indigo-600">
                {competitionType === 'individual' 
                  ? 'Individual competition this week' 
                  : `You're on ${myTeam === 'Team1' ? 'Team 1' : 'Team 2'} this week`}
              </p>
            </div>

            {competitionType === 'team' && (
              <div className="grid grid-cols-2 gap-2">
                <div className={`p-3 rounded-xl text-center ${
                  myTeam === 'Team1' 
                    ? 'bg-gradient-to-br from-indigo-100 to-purple-100 border-2 border-indigo-400' 
                    : teamPoints.Team1 > teamPoints.Team2
                      ? 'bg-gradient-to-br from-yellow-100 to-yellow-50 border-2 border-yellow-400'
                      : 'bg-gray-50 border-2 border-gray-200'
                }`}>
                  <p className="text-xs font-semibold text-gray-700">
                    {getTeamName('Team1')} {myTeam === 'Team1' && '(Your Team!)'}
                  </p>
                  <p className="text-xs text-gray-600 mb-1">
                    {currentTeams.Team1.map(k => k.split(' ')[0]).join(', ')}
                  </p>
                  {currentTeams.captains && (
                    <p className="text-xs text-indigo-600 mb-1">
                      👑 {currentTeams.captains.Team1}
                    </p>
                  )}
                  <p className="text-2xl font-bold text-indigo-600">{teamPoints.Team1}</p>
                  <p className="text-xs text-gray-500">points</p>
                </div>
                <div className={`p-3 rounded-xl text-center ${
                  myTeam === 'Team2' 
                    ? 'bg-gradient-to-br from-indigo-100 to-purple-100 border-2 border-indigo-400' 
                    : teamPoints.Team2 > teamPoints.Team1
                      ? 'bg-gradient-to-br from-yellow-100 to-yellow-50 border-2 border-yellow-400'
                      : 'bg-gray-50 border-2 border-gray-200'
                }`}>
                  <p className="text-xs font-semibold text-gray-700">
                    {getTeamName('Team2')} {myTeam === 'Team2' && '(Your Team!)'}
                  </p>
                  <p className="text-xs text-gray-600 mb-1">
                    {currentTeams.Team2.map(k => k.split(' ')[0]).join(', ')}
                  </p>
                  {currentTeams.captains && (
                    <p className="text-xs text-indigo-600 mb-1">
                      👑 {currentTeams.captains.Team2}
                    </p>
                  )}
                  <p className="text-2xl font-bold text-indigo-600">{teamPoints.Team2}</p>
                  <p className="text-xs text-gray-500">points</p>
                </div>
              </div>
            )}

            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">Individual Stats</p>
              <div className="space-y-2">
              {leaderboardData.map((kid, index) => {
                const isMe = kid.name === currentUser.name;
                return (
                  <div 
                    key={kid.name}
                    className={`p-3 rounded-xl ${
                      isMe ? 'bg-gradient-to-r from-indigo-100 to-purple-100 border-2 border-indigo-400' :
                      competitionType === 'individual' ? (
                        index === 0 ? 'bg-gradient-to-r from-yellow-100 to-yellow-50 border-2 border-yellow-400' :
                        index === 1 ? 'bg-gradient-to-r from-gray-100 to-gray-50 border-2 border-gray-300' :
                        index === 2 ? 'bg-gradient-to-r from-orange-100 to-orange-50 border-2 border-orange-300' :
                        'bg-gray-50'
                      ) : (
                        kid.team === myTeam ? 'bg-blue-50 border-l-4 border-blue-500' :
                        'bg-gray-50 border-l-4 border-gray-300'
                      )
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {competitionType === 'individual' && (
                          <div className={`text-xl font-bold ${
                            index === 0 ? 'text-yellow-600' :
                            index === 1 ? 'text-gray-600' :
                            index === 2 ? 'text-orange-600' :
                            'text-gray-400'
                          }`}>
                            {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`}
                          </div>
                        )}
                        <div>
                          <p className={`text-sm font-bold ${isMe ? 'text-indigo-700' : 'text-gray-800'}`}>
                            {kid.name} {isMe && '(You!)'}
                          </p>
                          <div className="flex items-center gap-2">
                            {competitionType === 'team' && (
                              <p className="text-xs text-gray-600">
                                {kid.team === myTeam ? '🤝 Teammate' : 'Other team'}
                              </p>
                            )}
                            {kid.streak > 0 && (
                              <span className="text-xs text-orange-600 font-semibold">
                                🔥 {kid.streak}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-xl font-bold ${isMe ? 'text-indigo-600' : 'text-indigo-600'}`}>
                          {kid.monthlyPoints}
                        </p>
                        <p className="text-xs text-gray-500">this month</p>
                        <p className="text-xs text-gray-400">{kid.points} all-time</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            </div>

            <div className="border-t border-gray-200 p-4">
              <button
                onClick={() => setShowLeaderboard(false)}
                className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;