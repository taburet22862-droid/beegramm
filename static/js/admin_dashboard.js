// Admin Dashboard Enhancements
document.addEventListener('DOMContentLoaded', function() {
    // Initialize charts
    initCharts();
    
    // Quick action buttons
    setupQuickActions();
    
    // Load real-time stats
    loadDashboardStats();
    
    // Update stats every 30 seconds
    setInterval(loadDashboardStats, 30000);
});

// Initialize Charts
function initCharts() {
    // User Growth Chart
    const userCtx = document.getElementById('userGrowthChart')?.getContext('2d');
    if (userCtx) {
        new Chart(userCtx, {
            type: 'line',
            data: {
                labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
                datasets: [{
                    label: 'New Users',
                    data: [65, 59, 80, 81, 56, 55, 40],
                    borderColor: 'rgba(124, 58, 237, 1)',
                    backgroundColor: 'rgba(124, 58, 237, 0.1)',
                    tension: 0.3,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    title: {
                        display: true,
                        text: 'User Growth',
                        color: 'var(--text)'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: 'var(--text-secondary)'
                        }
                    },
                    x: {
                        grid: {
                            display: false
                        },
                        ticks: {
                            color: 'var(--text-secondary)'
                        }
                    }
                }
            }
        });
    }
    
    // Activity Chart
    const activityCtx = document.getElementById('activityChart')?.getContext('2d');
    if (activityCtx) {
        new Chart(activityCtx, {
            type: 'bar',
            data: {
                labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                datasets: [{
                    label: 'Messages',
                    data: [1200, 1900, 1500, 2000, 1800, 1400, 1600],
                    backgroundColor: 'rgba(16, 185, 129, 0.7)',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    title: {
                        display: true,
                        text: 'Weekly Activity',
                        color: 'var(--text)'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: 'var(--text-secondary)'
                        }
                    },
                    x: {
                        grid: {
                            display: false
                        },
                        ticks: {
                            color: 'var(--text-secondary)'
                        }
                    }
                }
            }
        });
    }
}

// Quick Action Buttons
function setupQuickActions() {
    const actions = [
        {
            icon: 'fa-user-plus',
            title: 'Add User',
            description: 'Create a new user account',
            action: () => showModal('user-form-modal')
        },
        {
            icon: 'fa-key',
            title: 'Generate Keys',
            description: 'Create premium access keys',
            action: () => showGenerateKeysModal()
        },
        {
            icon: 'fa-bell',
            title: 'Send Notification',
            description: 'Broadcast message to users',
            action: () => showModal('notification-modal')
        },
        {
            icon: 'fa-cog',
            title: 'Settings',
            description: 'System configuration',
            action: () => window.location.href = '#settings'
        }
    ];
    
    const container = document.querySelector('.quick-actions');
    if (!container) return;
    
    container.innerHTML = actions.map(action => `
        <div class="quick-action-card" onclick="${action.action}">
            <i class="fas ${action.icon}"></i>
            <h3>${action.title}</h3>
            <p>${action.description}</p>
        </div>
    `).join('');
}

// Load Dashboard Stats
async function loadDashboardStats() {
    try {
        const [usersRes, messagesRes, premiumRes] = await Promise.all([
            fetch('/admin/users').then(res => res.json()),
            fetch('/api/stats/messages').then(res => res.json()),
            fetch('/api/stats/premium').then(res => res.json())
        ]);
        
        // Update stats cards
        if (usersRes.users) {
            document.getElementById('total-users').textContent = usersRes.users.length;
            const activeUsers = usersRes.users.filter(u => u.last_active > Date.now() - 86400000).length;
            document.getElementById('active-users').textContent = activeUsers;
        }
        
        if (messagesRes) {
            document.getElementById('total-messages').textContent = messagesRes.total || '0';
            document.getElementById('today-messages').textContent = messagesRes.today || '0';
        }
        
        if (premiumRes) {
            document.getElementById('premium-users').textContent = premiumRes.count || '0';
            document.getElementById('revenue').textContent = `$${premiumRes.revenue || '0'}`;
        }
        
    } catch (error) {
        console.error('Error loading dashboard stats:', error);
    }
}

// Show modal function
function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('open');
        document.body.style.overflow = 'hidden';
    }
}

// Close modal function
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('open');
        document.body.style.overflow = '';
    }
}

// Close modals when clicking outside
window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('open');
        document.body.style.overflow = '';
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal.open').forEach(modal => {
            modal.classList.remove('open');
            document.body.style.overflow = '';
        });
    }
});
