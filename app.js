/**
 * LLM Token Budget Planner
 * A dependency-free, single-page application for estimating LLM API costs.
 * * Architecture:
 * - State: Manages all user data and saves to localStorage.
 * - Calculator: Pure functions to perform all cost calculations.
 * - UI: Renders the HTML tables, charts, and results.
 * - App: The main controller that wires everything together.
 */

// --- 1. State Management ---
const State = (() => {
    const STATE_KEY = 'llmBudgetPlannerState';

    // Default state includes the test scenario
    const DEFAULT_STATE = {
    vendor_plans: [
    {
    id: 'plan_1',
    vendor: 'OpenAI',
    plan: 'Test-Plan (from prompt)',
    currency: 'EUR',
    price_prompt_per_1k: 0.002,
    price_completion_per_1k: 0.006,
    monthly_commit_credit: 0,
    free_tier_tokens: 0,
    overage_multiplier: 1.0,
    },
    {
    id: 'plan_2',
    vendor: 'Anthropic',
    plan: 'Opus',
    currency: 'USD',
    price_prompt_per_1k: 0.015,
    price_completion_per_1k: 0.075,
    monthly_commit_credit: 0,
    free_tier_tokens: 0,
    overage_multiplier: 1.0,
    }
    ],
    environments: [
    {
    id: 'env_1',
    env_name: 'Production (Test Scenario)',
    requests_per_day: 100,
    avg_tokens_per_request: 1000,
    context_tokens: 200,
    cache_hit_rate: 0.5,
    cache_savings_factor: 0.8,
    completion_share: 0.4,
    days_per_month: 30,
    budget_currency: 'EUR',
    monthly_budget: 20,
    alert_thresholds: { warn: 0.8, critical: 1.0 }
    },
    {
    id: 'env_2',
    env_name: 'Staging',
    requests_per_day: 50,
    avg_tokens_per_request: 2000,
    context_tokens: 1000,
    cache_hit_rate: 0.1,
    cache_savings_factor: 0.8,
    completion_share: 0.3,
    days_per_month: 22, // Work days
    budget_currency: 'USD',
    monthly_budget: 50,
    alert_thresholds: { warn: 0.8, critical: 1.0 }
    }
    ],
    plan_assignment: {
    'env_1': 'plan_1',
    'env_2': 'plan_2',
    }
    };

    let currentState = {};

    function load() {
    try {
    const stored = localStorage.getItem(STATE_KEY);
    currentState = stored ? JSON.parse(stored) : JSON.parse(JSON.stringify(DEFAULT_STATE)); // Deep copy
    // Ensure data integrity after loading
    if (!currentState.vendor_plans || !currentState.environments || !currentState.plan_assignment) {
    reset();
    }
    } catch (e) {
    console.error("Failed to load state, using defaults.", e);
    currentState = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
    }

    function save() {
    try {
    localStorage.setItem(STATE_KEY, JSON.stringify(currentState));
    } catch (e) {
    console.error("Failed to save state.", e);
    }
    }

    function get() {
    return currentState;
    }
    
    function update(partialState) {
    // Simple merge, not deep
    currentState = { ...currentState, ...partialState };
    save();
    // Notify the app that state has changed
    document.dispatchEvent(new Event('stateChange'));
    }

    function reset() {
    currentState = JSON.parse(JSON.stringify(DEFAULT_STATE));
    save();
    document.dispatchEvent(new Event('stateChange'));
    }

    load(); // Initial load

    return { get, update, reset };
})();


// --- 2. Calculation Engine ---
const Calculator = (() => {

    /**
    * Calculates all costs and stats for every environment.
    * @param {object} state - The current application state.
    * @returns {object} - { perEnv: [...], totals: {...} }
    */
    function calculateAll(state) {
    const { environments, vendor_plans, plan_assignment } = state;
    const resultsPerEnv = [];
    const totals = {
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    raw_cost: 0, // Note: Summing mixed currencies is indicative, not financially exact
    final_cost: 0,
    budget: 0,
    };
    
    const plansMap = new Map(vendor_plans.map(p => [p.id, p]));

    for (const env of environments) {
    const planId = plan_assignment[env.id];
    const plan = plansMap.get(planId);
    
    if (!plan) {
    // Handle case where plan is not assigned or deleted
    resultsPerEnv.push({
    env_id: env.id,
    env_name: env.env_name,
    error: "No valid plan assigned.",
    status: "N/A"
    });
    continue;
    }

    // 1) Effective tokens per request
    // effective = avg + context * (1 - hit_rate * savings)
    const cache_savings_factor = env.cache_savings_factor ?? 0.8;
    const effective_tokens_per_request = env.avg_tokens_per_request +
    (env.context_tokens * (1 - env.cache_hit_rate * cache_savings_factor));

    // 2) Monthly tokens per env
    const monthly_tokens = env.requests_per_day * effective_tokens_per_request * env.days_per_month;

    // 3) Split into prompt vs completion
    const completion_share = env.completion_share ?? 0.4;
    const prompt_share = 1 - completion_share;
    const prompt_tokens = monthly_tokens * prompt_share;
    const completion_tokens = monthly_tokens * completion_share;

    // 4) Convert to billable units (per 1K)
    const billable_prompt_1k = prompt_tokens / 1000;
    const billable_completion_1k = completion_tokens / 1000;
    
    // 5 & 6) Calculate costs, applying free tiers and commitments
    const costResult = calculateCost(
    prompt_tokens,
    completion_tokens,
    plan
    );
    
    // 7) Alerts
    const utilization = env.monthly_budget > 0 ? (costResult.final_cost / env.monthly_budget) : 0;
    const thresholds = env.alert_thresholds ?? { warn: 0.8, critical: 1.0 };
    
    let status = "GREEN";
    if (utilization >= thresholds.critical) {
    status = "RED";
    } else if (utilization >= thresholds.warn) {
    status = "AMBER";
    }

    // Suggestion logic
    let suggestion = "";
    if (status === "RED" || status === "AMBER") {
    const shortfall = costResult.final_cost - env.monthly_budget;
    if (shortfall > 0) {
    suggestion = `Budget shortfall of ${plan.currency} ${shortfall.toFixed(2)}. `;
    }
    const target_cost = env.monthly_budget * thresholds.warn; // Aim for just under warning
    const percent_to_reduce = costResult.final_cost > 0 ? (costResult.final_cost - target_cost) / costResult.final_cost : 0;
    
    if (percent_to_reduce > 0) {
    suggestion += `To reach safety (sub-${(thresholds.warn * 100).toFixed(0)}%), reduce token usage by ~${(percent_to_reduce * 100).toFixed(0)}% or raise budget.`;
    }
    }

    const envResult = {
    env_id: env.id,
    env_name: env.env_name,
    plan_name: `${plan.vendor} - ${plan.plan}`,
    currency: plan.currency,
    budget: env.monthly_budget,
    budget_currency: env.budget_currency,
    
    monthly_tokens: monthly_tokens,
    prompt_tokens: prompt_tokens,
    completion_tokens: completion_tokens,
    
    raw_cost: costResult.raw_cost,
    cost_after_free_tier: costResult.cost_after_free_tier,
    final_cost: costResult.final_cost,
    
    utilization: utilization,
    status: status,
    suggestion: suggestion,
    };

    resultsPerEnv.push(envResult);

    // Add to totals
    totals.total_tokens += monthly_tokens;
    totals.prompt_tokens += prompt_tokens;
    totals.completion_tokens += completion_tokens;
    // Warning: Naive currency sum
    totals.raw_cost += costResult.raw_cost;
    totals.final_cost += costResult.final_cost;
    totals.budget += env.monthly_budget;
    }

    return { perEnv: resultsPerEnv, totals: totals };
    }

    /**
    * Internal helper to calculate cost considering free tiers, commits, and overages.
    * @param {number} prompt_tokens - Total prompt tokens (not in 1k)
    * @param {number} completion_tokens - Total completion tokens (not in 1k)
    * @param {object} plan - The vendor plan object
    * @returns {object} - { raw_cost, cost_after_free_tier, final_cost }
    */
    function calculateCost(prompt_tokens, completion_tokens, plan) {
    let billable_prompt_tokens = prompt_tokens;
    let billable_completion_tokens = completion_tokens;
    const total_tokens = prompt_tokens + completion_tokens;

    // --- Step 6.1: Apply free_tier_tokens (pro-rata) ---
    const free_tier = plan.free_tier_tokens || 0;
    let cost_after_free_tier = 0;

    if (free_tier > 0 && total_tokens > 0) {
    const tokens_after_free = Math.max(0, total_tokens - free_tier);
    const free_tier_ratio = tokens_after_free / total_tokens; // Ratio of tokens that are *not* free

    billable_prompt_tokens = prompt_tokens * free_tier_ratio;
    billable_completion_tokens = completion_tokens * free_tier_ratio;
    }

    // Calculate cost based on (potentially reduced) billable tokens
    cost_after_free_tier = (billable_prompt_tokens / 1000 * plan.price_prompt_per_1k) +
    (billable_completion_tokens / 1000 * plan.price_completion_per_1k);

    // Raw cost is calculated *without* the free tier
    const raw_cost = (prompt_tokens / 1000 * plan.price_prompt_per_1k) +
    (completion_tokens / 1000 * plan.price_completion_per_1k);

    // --- Step 6.2: Apply monthly_commit_credit and overage ---
    const commit = plan.monthly_commit_credit || 0;
    let final_cost = cost_after_free_tier;

    if (commit > 0) {
    const overage_amount = Math.max(0, cost_after_free_tier - commit);
    const overage_multiplier = plan.overage_multiplier || 1.0;
    const overage_cost = overage_amount * overage_multiplier;
    
    // Final cost is the committed amount (up to the cost) + any overage cost
    final_cost = Math.min(cost_after_free_tier, commit) + overage_cost;
    }

    return {
    raw_cost: raw_cost,
    cost_after_free_tier: cost_after_free_tier,
    final_cost: final_cost
    };
    }

    return { calculateAll };
})();


// --- 3. UI/DOM Rendering ---
const UI = (() => {

    // Helper for number formatting
    const formatNum = (n, frac = 0) => n.toLocaleString(undefined, { minimumFractionDigits: frac, maximumFractionDigits: frac });
    const formatCurrency = (n, currency = "USD") => n.toLocaleString(undefined, { style: 'currency', currency: currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    
    // Getters for DOM elements
    const getEl = (id) => document.getElementById(id);
    const plansTable = getEl('vendor-plans-table');
    const envsTable = getEl('environments-table');
    const resultsTable = getEl('results-table');
    const costChart = getEl('cost-chart');
    const tokenChart = getEl('token-chart');

    /**
    * Renders the Vendor Plans table
    */
    function renderVendorPlans(plans) {
    let html = `<div class="table-wrapper"><table>
    <thead>
    <tr>
    <th>Vendor</th>
    <th>Plan Name</th>
    <th>Currency</th>
    <th>Prompt / 1K</th>
    <th>Completion / 1K</th>
    <th>Free Tokens</th>
    <th>Commit ($)</th>
    <th>Overage (x)</th>
    <th>Action</th>
    </tr>
    </thead>
    <tbody>`;
    
    plans.forEach((plan, index) => {
    html += `
    <tr>
    <td><input type="text" value="${plan.vendor}" data-table="plans" data-index="${index}" data-key="vendor"></td>
    <td><input type="text" value="${plan.plan}" data-table="plans" data-index="${index}" data-key="plan"></td>
    <td><input type="text" value="${plan.currency}" data-table="plans" data-index="${index}" data-key="currency" style="width: 60px;"></td>
    <td><input type="number" step="0.0001" min="0" value="${plan.price_prompt_per_1k}" data-table="plans" data-index="${index}" data-key="price_prompt_per_1k"></td>
    <td><input type="number" step="0.0001" min="0" value="${plan.price_completion_per_1k}" data-table="plans" data-index="${index}" data-key="price_completion_per_1k"></td>
    <td><input type="number" step="1000" min="0" value="${plan.free_tier_tokens}" data-table="plans" data-index="${index}" data-key="free_tier_tokens"></td>
    <td><input type="number" step="1" min="0" value="${plan.monthly_commit_credit}" data-table="plans" data-index="${index}" data-key="monthly_commit_credit"></td>
    <td><input type="number" step="0.1" min="0" value="${plan.overage_multiplier}" data-table="plans" data-index="${index}" data-key="overage_multiplier"></td>
    <td><button class="btn-delete" data-action="delete-plan" data-index="${index}">Delete</button></td>
    </tr>`;
    });
    
    html += `</tbody></table></div>`;
    plansTable.innerHTML = html;
    }

    /**
    * Renders the Environments table and Plan Assignment
    */
    function renderEnvironments(envs, plans, planAssignment) {
    // Create <option> HTML for the plan selector
    const planOptions = plans.map(p => 
    `<option value="${p.id}">${p.vendor} - ${p.plan} (${p.currency})</option>`
    ).join('');

    let html = `<div class="table-wrapper"><table>
    <thead>
    <tr>
    <th>Environment</th>
    <th>Assigned Plan</th>
    <th>Reqs / Day</th>
    <th>Avg Tokens / Req</th>
    <th>Context Tokens</th>
    <th>Cache Hit (%)</th>
    <th>Cache Save (%)</th>
    <th>Completion (%)</th>
    <th>Days / Month</th>
    <th>Budget</th>
    <th>Budget Currency</th>
    <th>Action</th>
    </tr>
    </thead>
    <tbody>`;
    
    envs.forEach((env, index) => {
    const assignedPlanId = planAssignment[env.id];
    
    // Build the <select> element with the correct plan selected
    let selectHtml = `<select data-table="assignment" data-env-id="${env.id}">`;
    selectHtml += `<option value="">-- Select a Plan --</option>`;
    plans.forEach(p => {
    selectHtml += `<option value="${p.id}" ${p.id === assignedPlanId ? 'selected' : ''}>${p.vendor} - ${p.plan}</option>`;
    });
    selectHtml += `</select>`;

    html += `
    <tr>
    <td><input type="text" value="${env.env_name}" data-table="envs" data-index="${index}" data-key="env_name"></td>
    <td>${selectHtml}</td>
    <td><input type="number" min="0" value="${env.requests_per_day}" data-table="envs" data-index="${index}" data-key="requests_per_day"></td>
    <td><input type="number" min="0" value="${env.avg_tokens_per_request}" data-table="envs" data-index="${index}" data-key="avg_tokens_per_request"></td>
    <td><input type="number" min="0" value="${env.context_tokens}" data-table="envs" data-index="${index}" data-key="context_tokens"></td>
    <td><input type="number" step="0.01" min="0" max="1" value="${env.cache_hit_rate}" data-table="envs" data-index="${index}" data-key="cache_hit_rate"></td>
    <td><input type="number" step="0.01" min="0" max="1" value="${env.cache_savings_factor}" data-table="envs" data-index="${index}" data-key="cache_savings_factor"></td>
    <td><input type="number" step="0.01" min="0" max="1" value="${env.completion_share}" data-table="envs" data-index="${index}" data-key="completion_share"></td>
    <td><input type="number" step="1" min="1" max="31" value="${env.days_per_month}" data-table="envs" data-index="${index}" data-key="days_per_month"></td>
    <td><input type="number" min="0" value="${env.monthly_budget}" data-table="envs" data-index="${index}" data-key="monthly_budget"></td>
    <td><input type="text" value="${env.budget_currency}" data-table="envs" data-index="${index}" data-key="budget_currency" style="width: 60px;"></td>
    <td><button class="btn-delete" data-action="delete-env" data-index="${index}">Delete</button></td>
    </tr>`;
    });
    
    html += `</tbody></table></div>`;
    envsTable.innerHTML = html;
    }

    /**
    * Renders the Results table
    */
    function renderResults(results) {
    const { perEnv, totals } = results;

    let html = `<div class="table-wrapper"><table>
    <thead>
    <tr>
    <th>Environment</th>
    <th>Status</th>
    <th>Final Cost / Month</th>
    <th>Budget</th>
    <th>Utilization</th>
    <th>Total Tokens / Month</th>
    <th>Prompt Tokens</th>
    <th>Completion Tokens</th>
    <th>Raw Cost</th>
    </tr>
    </thead>
    <tbody>`;

    perEnv.forEach(res => {
    if (res.error) {
    html += `<tr>
    <td>${res.env_name}</td>
    <td colspan="8"><span class="status-RED">${res.error}</span></td>
    </tr>`;
    return;
    }

    // Check for currency mismatch
    const budgetMismatch = res.currency !== res.budget_currency;
    const budgetDisplay = `${formatCurrency(res.budget, res.budget_currency)} ${budgetMismatch ? `(${res.budget_currency})` : ''}`;
    const costDisplay = `${formatCurrency(res.final_cost, res.currency)}`;

    html += `
    <tr>
    <td>
    <strong>${res.env_name}</strong>
    <div class="suggestion">${res.plan_name}</div>
    </td>
    <td>
    <span class="status status-${res.status}">${res.status}</span>
    ${res.suggestion ? `<div class="suggestion">${res.suggestion}</div>` : ''}
    </td>
    <td><strong>${costDisplay}</strong></td>
    <td>${budgetDisplay} ${budgetMismatch ? `<div class="suggestion" style="color: var(--color-red);">Warning: Plan/Budget currency mismatch.</div>` : ''}</td>
    <td><strong>${(res.utilization * 100).toFixed(1)}%</strong></td>
    <td>${formatNum(res.monthly_tokens)}</td>
    <td>${formatNum(res.prompt_tokens)}</td>
    <td>${formatNum(res.completion_tokens)}</td>
    <td>${formatCurrency(res.raw_cost, res.currency)}</td>
    </tr>`;
    });
    
    // Totals Row
    html += `
    <tr style="background-color: var(--color-bg); font-weight: bold;">
    <td>Total</td>
    <td></td>
    <td>${formatNum(totals.final_cost, 2)}*</td>
    <td>${formatNum(totals.budget, 2)}*</td>
    <td></td>
    <td>${formatNum(totals.total_tokens)}</td>
    <td>${formatNum(totals.prompt_tokens)}</td>
    <td>${formatNum(totals.completion_tokens)}</td>
    <td>${formatNum(totals.raw_cost, 2)}*</td>
    </tr>`;

    html += `</tbody></table></div>
    <p class="suggestion" style="text-align: right; margin-top: 8px;">
    *Total costs are a naive sum and may include mixed currencies.
    </p>`;
    resultsTable.innerHTML = html;
    }
    
    /**
    * Renders the simple CSS bar charts
    */
    function renderCharts(results) {
    const { perEnv, totals } = results;
    
    // 1. Cost Chart
    let costHtml = '';
    const maxCost = Math.max(...perEnv.map(r => r.final_cost || 0), 1); // Avoid div by zero
    
    perEnv.forEach(res => {
    if (res.error) return;
    const width = (res.final_cost / maxCost) * 100;
    const costDisplay = `${formatCurrency(res.final_cost, res.currency)}`;
    costHtml += `
    <div class="chart-bar-group">
    <div class="chart-label">${res.env_name} (${costDisplay})</div>
    <div class="chart-bar-container">
    <div class="chart-bar bar-cost" style="width: ${width}%;">
    ${width > 20 ? costDisplay : ''}
    </div>
    </div>
    </div>
    `;
    });
    costChart.innerHTML = costHtml || '<p class="suggestion">No data to display.</p>';

    // 2. Token Chart
    let tokenHtml = '';
    if (totals.total_tokens > 0) {
    const promptShare = (totals.prompt_tokens / totals.total_tokens) * 100;
    const completionShare = (totals.completion_tokens / totals.total_tokens) * 100;
    
    tokenHtml = `
    <div class="chart-bar-group">
    <div class="chart-label">Total Token Distribution</div>
    <div class="chart-bar-container">
    <div class="chart-bar bar-prompt" style="width: ${promptShare}%;">
    Prompt: ${formatNum(totals.prompt_tokens)} (${promptShare.toFixed(1)}%)
    </div>
    <div class="chart-bar bar-completion" style="width: ${completionShare}%;">
    Completion: ${formatNum(totals.completion_tokens)} (${completionShare.toFixed(1)}%)
    </div>
    </div>
    </div>
    `;
    }
    tokenChart.innerHTML = tokenHtml || '<p class="suggestion">No data to display.</p>';
    }

    /**
    * Main render function
    */
    function renderAll(state, results) {
    renderVendorPlans(state.vendor_plans);
    renderEnvironments(state.environments, state.vendor_plans, state.plan_assignment);
    renderResults(results);
    renderCharts(results);
    }

    return { renderAll };
})();


// --- 4. Exporter Functions ---
const Exporter = (() => {
    
    function download(filename, text) {
    const element = document.createElement('a');
    element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
    element.setAttribute('download', filename);
    element.style.display = 'none';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
    }

    function exportCSV(results) {
    const { perEnv } = results;
    if (perEnv.length === 0) return;

    const headers = [
    "Environment", "Status", "Plan", 
    "Final Cost", "Currency", "Budget", "Budget Currency", "Utilization %",
    "Total Tokens", "Prompt Tokens", "Completion Tokens", "Raw Cost",
    "Suggestion"
    ];
    
    let csvContent = headers.join(',') + '\r\n';

    perEnv.forEach(res => {
    if (res.error) return;
    const row = [
    `"${res.env_name}"`,
    res.status,
    `"${res.plan_name}"`,
    res.final_cost.toFixed(2),
    res.currency,
    res.budget.toFixed(2),
    res.budget_currency,
    (res.utilization * 100).toFixed(2),
    Math.round(res.monthly_tokens),
    Math.round(res.prompt_tokens),
    Math.round(res.completion_tokens),
    res.raw_cost.toFixed(2),
    `"${res.suggestion.replace(/"/g, '""')}"` // Escape quotes
    ];
    csvContent += row.join(',') + '\r\n';
    });
    
    download('llm-budget-results.csv', csvContent);
    }

    function exportJSON(state, results) {
    const data = {
    metadata: {
    exported_at: new Date().toISOString(),
    tool: "LLM Budget Planner"
    },
    config: state,
    results: results
    };
    download('llm-budget-config.json', JSON.stringify(data, null, 2));
    }
    
    return { exportCSV, exportJSON };
})();


// --- 5. App Controller ---
const App = (() => {
    
    // Debounce timer for input changes
    let debounceTimer = null;
    const DEBOUNCE_DELAY = 300; // milliseconds

    function init() {
    // Initial render
    mainRenderLoop();
    
    // --- Event Listeners ---
    
    // Listen for state changes (e.g., from State.reset())
    document.addEventListener('stateChange', mainRenderLoop);

    // Listen for user inputs (delegated) - with debouncing
    document.getElementById('app').addEventListener('input', handleInputChange);
    
    // Listen for clicks (delegated)
    document.getElementById('app').addEventListener('click', handleButtonClick);
    }

    /**
    * The main loop: Get state, calculate, and render.
    */
    function mainRenderLoop() {
    const state = State.get();
    const results = Calculator.calculateAll(state);
    UI.renderAll(state, results);
    }

    /**
    * Handle all clicks on buttons
    */
    function handleButtonClick(e) {
    const target = e.target;
    const action = target.dataset?.action;
    const index = parseInt(target.dataset?.index, 10);
    const state = State.get();

    if (action === 'delete-plan') {
    e.preventDefault();
    const planId = state.vendor_plans[index].id;
    const newState = { ...state };
    newState.vendor_plans.splice(index, 1);
    
    // Un-assign this plan from any envs
    Object.keys(newState.plan_assignment).forEach(envId => {
    if (newState.plan_assignment[envId] === planId) {
    newState.plan_assignment[envId] = "";
    }
    });
    
    State.update(newState);
    return;
    }
    
    if (action === 'delete-env') {
    e.preventDefault();
    const envId = state.environments[index].id;
    const newState = { ...state };
    newState.environments.splice(index, 1);
    delete newState.plan_assignment[envId]; // Remove assignment
    State.update(newState);
    return;
    }
    
    // --- Static Buttons ---
    switch (target.id) {
    case 'add-plan-btn': {
    e.preventDefault();
    const newPlan = {
    id: `plan_${Date.now()}`,
    vendor: 'Other', plan: 'New Plan', currency: 'USD',
    price_prompt_per_1k: 0.01, price_completion_per_1k: 0.03,
    monthly_commit_credit: 0, free_tier_tokens: 0, overage_multiplier: 1.0,
    };
    State.update({ vendor_plans: [...state.vendor_plans, newPlan] });
    break;
    }
    case 'add-env-btn': {
    e.preventDefault();
    const newEnv = {
    id: `env_${Date.now()}`,
    env_name: 'New Environment',
    requests_per_day: 10, avg_tokens_per_request: 1000, context_tokens: 500,
    cache_hit_rate: 0, cache_savings_factor: 0.8, completion_share: 0.4,
    days_per_month: 30, monthly_budget: 10, budget_currency: 'USD',
    alert_thresholds: { warn: 0.8, critical: 1.0 }
    };
    State.update({ environments: [...state.environments, newEnv] });
    break;
    }
    case 'export-csv-btn': {
    e.preventDefault();
    const results = Calculator.calculateAll(state);
    Exporter.exportCSV(results);
    break;
    }
    case 'export-json-btn': {
    e.preventDefault();
    const results = Calculator.calculateAll(state);
    Exporter.exportJSON(state, results);
    break;
    }
    case 'reset-btn': {
    e.preventDefault();
    if (confirm('Are you sure you want to reset all data to the default test scenario? This cannot be undone.')) {
    try {
    // Clear localStorage and reset state
    localStorage.removeItem('llmBudgetPlannerState');
    State.reset();
    console.log('Successfully reset to defaults');
    } catch (err) {
    console.error('Error during reset:', err);
    alert('Error resetting data. Please try refreshing the page.');
    }
    }
    break;
    }
    }
    }

    /**
    * Handle all changes to <input> and <select> fields with debouncing
    */
    function handleInputChange(e) {
    const el = e.target;
    const table = el.dataset?.table;
    
    if (!table) return; // Not an input we care about
    
    // Clear any existing debounce timer
    if (debounceTimer) {
    clearTimeout(debounceTimer);
    }
    
    // Set a new debounce timer
    debounceTimer = setTimeout(() => {
    updateStateFromInput(el, table);
    }, DEBOUNCE_DELAY);
    }
    
    /**
    * Actually update the state from an input element
    */
    function updateStateFromInput(el, table) {
    const state = State.get();
    let newState = { ...state };

    // Parse value (numbers or text)
    let value = el.value;
    if (el.type === 'number') {
    value = parseFloat(value);
    if (isNaN(value)) value = 0; // Default to 0 if invalid
    // Enforce min/max constraints
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    if (!isNaN(min) && value < min) value = min;
    if (!isNaN(max) && value > max) value = max;
    }

    if (table === 'plans') {
    const index = parseInt(el.dataset.index, 10);
    const key = el.dataset.key;
    // Create a new array and update the specific item
    const newPlans = [...state.vendor_plans];
    newPlans[index] = { ...newPlans[index], [key]: value };
    newState.vendor_plans = newPlans;
    } 
    
    else if (table === 'envs') {
    const index = parseInt(el.dataset.index, 10);
    const key = el.dataset.key;
    const newEnvs = [...state.environments];
    newEnvs[index] = { ...newEnvs[index], [key]: value };
    newState.environments = newEnvs;
    } 
    
    else if (table === 'assignment') {
    const envId = el.dataset.envId;
    const newAssignments = { ...state.plan_assignment };
    newAssignments[envId] = value; // value is the planId
    newState.plan_assignment = newAssignments;
    }

    // Commit the change
    State.update(newState);
    }

    return { init };
})();

// Start the app when the DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
} else {
    // DOM is already ready
    App.init();
}
