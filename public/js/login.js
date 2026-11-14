document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const rememberMeCheck = document.getElementById('remember-me');
    const errorBox = document.getElementById('error-box') || document.getElementById('error-msg');
    const errorText = document.getElementById('error-text');
    const loginBtn = document.getElementById('login-btn');
    const loginIcon = document.getElementById('login-icon');
    const loginText = document.getElementById('login-text');

    // Redirect cleanly to dashboard when auth is disabled by default
    fetch('/api/public-config', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((cfg) => {
            if (cfg && cfg.authRequired === false) {
                window.location.replace('/');
            }
        })
        .catch(() => {});

    if (!loginForm) return;

    function setLoading(isLoading) {
        if (!loginBtn) return;
        loginBtn.disabled = Boolean(isLoading);
        loginBtn.classList.toggle('is-loading', Boolean(isLoading));
        if (loginIcon) {
            loginIcon.className = isLoading
                ? 'fa-solid fa-spinner fa-spin'
                : 'fa-solid fa-right-to-bracket';
        }
        if (loginText) {
            loginText.textContent = isLoading ? 'Đang xác thực...' : 'Đăng nhập hệ thống';
        }
    }

    // Load saved credentials from localStorage if available
    try {
        const savedUser = localStorage.getItem('tcs_remember_user');
        const savedPass = localStorage.getItem('tcs_remember_pass');
        if (savedUser && savedPass) {
            if (usernameInput) usernameInput.value = savedUser;
            if (passwordInput) passwordInput.value = savedPass;
            if (rememberMeCheck) rememberMeCheck.checked = true;
        }
    } catch (e) {}

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (errorBox) errorBox.style.display = 'none';

        const username = usernameInput ? usernameInput.value.trim() : '';
        const password = passwordInput ? passwordInput.value : '';
        const rememberMe = rememberMeCheck ? rememberMeCheck.checked : false;

        if (!username || !password) {
            showError('Vui lòng nhập đầy đủ tài khoản và mật khẩu.');
            return;
        }

        setLoading(true);

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password, rememberMe })
            });

            let data = {};
            try {
                data = await response.json();
            } catch (e) {
                data = {};
            }

            if (response.ok && data.success) {
                if (data.role && data.role !== 'admin') {
                    showError('Chỉ hỗ trợ đăng nhập tài khoản Quản trị (Admin).');
                    return;
                }
                try {
                    if (rememberMe) {
                        localStorage.setItem('tcs_remember_user', username);
                        localStorage.setItem('tcs_remember_pass', password);
                    } else {
                        localStorage.removeItem('tcs_remember_user');
                        localStorage.removeItem('tcs_remember_pass');
                    }
                } catch (e) {}

                window.location.href = '/';
            } else {
                showError(data.message || 'Tài khoản hoặc mật khẩu không chính xác.');
            }
        } catch (error) {
            console.error('Error logging in:', error);
            showError('Không thể kết nối đến máy chủ. Vui lòng thử lại sau.');
        }
    });

    function showError(message) {
        if (errorText) errorText.textContent = message;
        if (errorBox) {
            errorBox.style.display = 'flex';
            errorBox.classList.remove('shake');
            void errorBox.offsetWidth;
            errorBox.classList.add('shake');
        }
        setLoading(false);
    }
});
