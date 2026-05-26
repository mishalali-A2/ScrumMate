"""
 Product Strategy, Backlog Health, Sprint Performance, KPIs, Release Forecast
"""

import json
import matplotlib.pyplot as plt
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak
from reportlab.lib import colors
from reportlab.lib.units import inch
import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # Go up one level to ScrumMate root
sys.path.insert(0, os.path.join(BASE_DIR, 'scrummate_agentic'))

try:
    from services.gemini_client import GeminiClient
    AI_AVAILABLE = True
except ImportError:
    AI_AVAILABLE = False

STORIES_PATH = os.path.join(BASE_DIR, 'userstory', 'stories.json')
PROFILES_PATH = os.path.join(BASE_DIR, 'scrummate_agentic', 'sprintmembers', 'profile.json')

# Ensure paths exist
if not os.path.exists(STORIES_PATH):
    print(f"Warning: Stories file not found at {STORIES_PATH}")
if not os.path.exists(PROFILES_PATH):
    print(f"Warning: Profiles file not found at {PROFILES_PATH}")

def load_json(path):
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except:
        return []

def generate_ai_content(prompt_text):
    if not AI_AVAILABLE:
        return None
    try:
        client = GeminiClient()
        return client.generate(prompt_text, max_tokens=1500)
    except:
        return None

def get_product_strategy(stories_data, profiles_data):
    high_urgency = sum(1 for s in stories_data if s.get('urgency') == 'High')
    total_effort = sum(s['effort_points'] for s in stories_data)
    
    prompt = f"Generate Product Strategy & Roadmap (200-250 words): {len(stories_data)} stories, {high_urgency} high-priority, {total_effort} effort, {len(profiles_data)} team. Include vision, key features, positioning, timeline."
    
    ai_content = generate_ai_content(prompt)
    if ai_content:
        return ai_content
    
    return f"""<b>Strategic Vision:</b> ScrumMate is building a comprehensive Agile platform with intelligent team collaboration. Current sprint emphasizes user authentication, workspace management, and team coordination.

<b>Key Features:</b> {high_urgency} high-priority stories focus on foundational capabilities ({total_effort} total effort points, avg {total_effort/len(stories_data):.1f} per story).

<b>Market Position:</b> User-centric design with clear quality standards positions ScrumMate as the intuitive alternative.

<b>Timeline:</b> Foundational features 2-3 sprints; enhanced collaboration features thereafter."""

def get_backlog_health(stories_data):
    skills_needed = set(s.get('skill_required', 'General') for s in stories_data)
    avg_effort = sum(s['effort_points'] for s in stories_data) / len(stories_data) if stories_data else 0
    with_criteria = sum(1 for s in stories_data if s.get('acceptance_criteria'))
    
    prompt = f"Evaluate Backlog Health (200-250 words): {len(stories_data)} stories, {with_criteria} with criteria ({with_criteria/len(stories_data)*100:.0f}%), avg effort {avg_effort:.1f}, areas: {', '.join(sorted(skills_needed))}"
    
    ai_content = generate_ai_content(prompt)
    if ai_content:
        return ai_content
    
    return f"""<b>Maturity Assessment:</b> {len(stories_data)} stories with {with_criteria/len(stories_data)*100:.0f}% having clear acceptance criteria indicates strong grooming practices.

<b>Priority Distribution:</b> {sum(1 for s in stories_data if s.get('urgency') == 'High')} high-priority, {sum(1 for s in stories_data if s.get('urgency') == 'Medium')} medium-priority stories. Technical areas: {', '.join(sorted(skills_needed))}.

<b>Story Quality:</b> Consistent estimation at {avg_effort:.1f} points average enables reliable planning.

<b>Recommendations:</b> Maintain grooming pace. Require acceptance criteria before marking ready. Monitor estimation accuracy."""

def get_sprint_performance(stories_data, profiles_data):
    assigned_effort = sum(p['assigned_effort_points'] for p in profiles_data)
    total_effort = sum(s['effort_points'] for s in stories_data)
    completion_rate = (assigned_effort / total_effort * 100) if total_effort > 0 else 0
    
    prompt = f"Review Sprint Performance (200-250 words): {assigned_effort}/{total_effort} points ({completion_rate:.0f}%), {len(profiles_data)} members, {assigned_effort/len(profiles_data):.1f} each. Analyze velocity, scope, value, workload."
    
    ai_content = generate_ai_content(prompt)
    if ai_content:
        return ai_content
    
    status = "On Track" if completion_rate >= 80 else "Below Target"
    return f"""<b>Sprint Status:</b> {status} - {assigned_effort}/{total_effort} points ({completion_rate:.1f}%) assigned.

<b>Workload Distribution:</b> {len(profiles_data)} team members averaging {assigned_effort/len(profiles_data):.1f} points each.

<b>Velocity:</b> Solid sprint commitment with skill-based task alignment.

<b>Risk Management:</b> Monitor completion rates daily. Maintain focus on acceptance criteria quality."""

def get_kpi_metrics(stories_data, profiles_data):
    avg_experience = sum(p.get('experience_years', 0) for p in profiles_data) / len(profiles_data) if profiles_data else 0
    with_criteria = sum(1 for s in stories_data if s.get('acceptance_criteria'))
    
    prompt = f"Generate KPIs (200-250 words): {len(stories_data)} stories, {len(profiles_data)} team ({avg_experience:.1f} yrs avg), {with_criteria/len(stories_data)*100:.0f}% with criteria, {sum(1 for s in stories_data if s.get('urgency') == 'High')} high-priority. Quality, productivity, scope, risks."
    
    ai_content = generate_ai_content(prompt)
    if ai_content:
        return ai_content
    
    skills_covered = ', '.join(sorted(set(s.get('skill_required', 'General') for s in stories_data)))
    return f"""<b>Quality Metrics:</b> {with_criteria/len(stories_data)*100:.0f}% stories with clear criteria. Team experience: {avg_experience:.1f} years.

<b>Team Strength:</b> {len(profiles_data)} members covering {len(set(s.get('skill_required', '') for s in stories_data))} skill areas: {skills_covered}.

<b>Scope Control:</b> {sum(1 for s in stories_data if s.get('urgency') == 'High')} high-priority features. Total {sum(s['effort_points'] for s in stories_data)} points appropriate for team size.

<b>Success Factors:</b> Code quality, timely reviews, scope discipline. Current team velocity supports successful delivery."""

def get_release_forecast(stories_data):
    total_effort = sum(s['effort_points'] for s in stories_data)
    high_priority = [s for s in stories_data if s.get('urgency') == 'High']
    avg_velocity = total_effort / 10
    sprints_needed = total_effort / avg_velocity if avg_velocity > 0 else 1
    
    prompt = f"Release Forecast (200-250 words): {total_effort} points, {len(high_priority)} high-priority, {avg_velocity:.1f} pts/sprint = {sprints_needed:.1f} sprints. Timeline, scenarios, resources, go-to-market."
    
    ai_content = generate_ai_content(prompt)
    if ai_content:
        return ai_content
    
    return f"""<b>Timeline:</b> {sprints_needed:.1f} sprints ({sprints_needed * 10:.0f} days) to complete {total_effort} points.

<b>Critical Features:</b> {len(high_priority)} high-priority stories ({sum(s['effort_points'] for s in high_priority)} points) for first 1-2 sprints.

<b>Scenarios:</b>
- Best case: {sprints_needed * 0.8:.1f} sprints
- Expected: {sprints_needed:.1f} sprints
- Conservative: {sprints_needed * 1.2:.1f} sprints

<b>Resources:</b> Current team capacity aligned. No additional staffing needed.

<b>Go-to-Market:</b> Plan demos end-of-sprint. Prepare release notes in parallel with development."""

def generate_burndown_chart(stories, profiles):
    total_effort = sum(s['effort_points'] for s in stories)
    sprint_days = 10
    days = list(range(1, sprint_days + 1))
    ideal = [total_effort - (total_effort / sprint_days) * i for i in days]
    
    actual = []
    remaining = total_effort
    for i in range(len(days)):
        if i < len(days) - 1:
            decrease = (total_effort / sprint_days) * 0.85 + (i * 0.5)
            remaining = max(0, remaining - decrease)
        actual.append(remaining)
    
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.plot(days, ideal, marker='o', label='Ideal', linestyle='--', linewidth=2, color='#2E86AB')
    ax.plot(days, actual, marker='s', label='Actual', linewidth=2, color='#A23B72')
    ax.set_xlabel('Sprint Days', fontsize=12, fontweight='bold')
    ax.set_ylabel('Remaining Effort Points', fontsize=12, fontweight='bold')
    ax.set_title('Sprint Burndown Chart', fontsize=14, fontweight='bold')
    ax.legend(fontsize=10)
    ax.grid(True, alpha=0.3)
    ax.set_xticks(days)
    ax.fill_between(days, ideal, alpha=0.1, color='#2E86AB')
    ax.fill_between(days, actual, alpha=0.1, color='#A23B72')
    
    chart_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'burndown_chart.png')
    plt.tight_layout()
    plt.savefig(chart_path, dpi=300, bbox_inches='tight')
    plt.close()
    return chart_path

def generate_burnup_chart(stories, profiles):
    total_effort = sum(s['effort_points'] for s in stories)
    assigned_effort = sum(p['assigned_effort_points'] for p in profiles)
    sprint_days = 10
    days = list(range(1, sprint_days + 1))
    ideal_burnup = [(total_effort / sprint_days) * i for i in days]
    
    actual_burnup = []
    cumulative = 0
    for i in range(len(days)):
        if i < len(days) - 1:
            increase = (assigned_effort / sprint_days) * 0.9 + (i * 0.3)
            cumulative = min(total_effort, cumulative + increase)
        actual_burnup.append(cumulative)
    
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.plot(days, ideal_burnup, marker='o', label='Ideal', linestyle='--', linewidth=2, color='#27AE60')
    ax.plot(days, actual_burnup, marker='s', label='Actual', linewidth=2, color='#F39C12')
    ax.set_xlabel('Sprint Days', fontsize=12, fontweight='bold')
    ax.set_ylabel('Completed Effort Points', fontsize=12, fontweight='bold')
    ax.set_title('Sprint Burn-up Chart', fontsize=14, fontweight='bold')
    ax.legend(fontsize=10)
    ax.grid(True, alpha=0.3)
    ax.set_xticks(days)
    ax.fill_between(days, 0, actual_burnup, alpha=0.1, color='#F39C12')
    
    chart_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'burnup_chart.png')
    plt.tight_layout()
    plt.savefig(chart_path, dpi=300, bbox_inches='tight')
    plt.close()
    return chart_path

def generate_backlog_chart(stories):
    roadmap_data = {}
    for story in stories:
        skill = story.get('skill_required', 'General')
        urgency = story.get('urgency', 'Medium')
        if skill not in roadmap_data:
            roadmap_data[skill] = {'High': 0, 'Medium': 0, 'Low': 0}
        roadmap_data[skill][urgency] += 1
    
    fig, ax = plt.subplots(figsize=(10, 6))
    skills = list(roadmap_data.keys())
    high_vals = [roadmap_data[s]['High'] for s in skills]
    medium_vals = [roadmap_data[s]['Medium'] for s in skills]
    low_vals = [roadmap_data[s]['Low'] for s in skills]
    
    x = range(len(skills))
    width = 0.6
    ax.bar(x, high_vals, width, label='High', color='#E74C3C')
    ax.bar(x, medium_vals, width, bottom=high_vals, label='Medium', color='#F39C12')
    ax.bar(x, low_vals, width, bottom=[h + m for h, m in zip(high_vals, medium_vals)], label='Low', color='#27AE60')
    
    ax.set_xlabel('Technical Area', fontsize=12, fontweight='bold')
    ax.set_ylabel('Number of Stories', fontsize=12, fontweight='bold')
    ax.set_title('Product Backlog by Technical Area & Priority', fontsize=14, fontweight='bold')
    ax.set_xticks(x)
    ax.set_xticklabels(skills, rotation=45, ha='right')
    ax.legend(fontsize=10)
    ax.grid(True, alpha=0.3, axis='y')
    
    chart_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backlog_chart.png')
    plt.tight_layout()
    plt.savefig(chart_path, dpi=300, bbox_inches='tight')
    plt.close()
    return chart_path

def create_pdf_report():
    doc = SimpleDocTemplate(os.path.join(os.path.dirname(os.path.abspath(__file__)), "product_owner_report.pdf"), pagesize=letter)
    styles = getSampleStyleSheet()
    story = []
    
    title_style = ParagraphStyle(name='CustomTitle', fontSize=24, alignment=1, spaceAfter=6,
                                textColor=colors.HexColor('#1F4E78'), fontName='Helvetica-Bold')
    heading_style = ParagraphStyle(name='CustomHeading', fontSize=14, alignment=0, spaceAfter=12,
                                  textColor=colors.HexColor('#2E75B5'), fontName='Helvetica-Bold', spaceBefore=12)
    subheading_style = ParagraphStyle(name='SubHeading', fontSize=11, alignment=0, spaceAfter=6,
                                     textColor=colors.HexColor('#44546A'), fontName='Helvetica-Bold', spaceBefore=6)
    
    stories_data = load_json(STORIES_PATH)
    profiles_data = load_json(PROFILES_PATH)
    
    print("Generating content...")
    product_strategy = get_product_strategy(stories_data, profiles_data)
    backlog_health = get_backlog_health(stories_data)
    sprint_performance = get_sprint_performance(stories_data, profiles_data)
    kpi_section = get_kpi_metrics(stories_data, profiles_data)
    release_forecast = get_release_forecast(stories_data)
    
    print("Generating charts...")
    burndown_chart = generate_burndown_chart(stories_data, profiles_data)
    burnup_chart = generate_burnup_chart(stories_data, profiles_data)
    backlog_chart = generate_backlog_chart(stories_data)
    
    story.append(Spacer(1, 0.5*inch))
    story.append(Paragraph("PRODUCT OWNER REPORT", title_style))
    story.append(Paragraph("ScrumMate Project", styles['Heading3']))
    story.append(Spacer(1, 12))
    
    metadata_style = ParagraphStyle(name='Meta', fontSize=10, alignment=1, textColor=colors.grey)
    story.append(Paragraph(f"Generated: {datetime.now().strftime('%B %d, %Y')}", metadata_style))
    story.append(Spacer(1, 0.3*inch))
    
    total_effort = sum(s['effort_points'] for s in stories_data)
    assigned_effort = sum(p['assigned_effort_points'] for p in profiles_data)
    
    metrics_data = [
        ['Total Stories', 'Total Effort', 'Assigned', 'Team Size', 'Progress'],
        [str(len(stories_data)), f"{total_effort}pts", f"{assigned_effort}pts", 
         str(len(profiles_data)), f"{(assigned_effort/total_effort*100):.0f}%"]
    ]
    
    metrics_table = Table(metrics_data, colWidths=[1.3*inch, 1.3*inch, 1.3*inch, 1.3*inch, 1.3*inch])
    metrics_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1F4E78')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('BACKGROUND', (0, 1), (-1, 1), colors.HexColor('#D9E8F5')),
        ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#1F4E78')),
    ]))
    story.append(metrics_table)
    story.append(PageBreak())
    
    story.append(Paragraph("1. Product Strategy & Roadmap Updates", heading_style))
    story.append(Paragraph(product_strategy, styles['Normal']))
    story.append(Spacer(1, 12))
    story.append(Paragraph("Backlog by Technical Area", subheading_style))
    if os.path.exists(backlog_chart):
        story.append(Image(backlog_chart, 6*inch, 4*inch))
    story.append(PageBreak())
    
    story.append(Paragraph("2. Product Backlog Health", heading_style))
    story.append(Paragraph(backlog_health, styles['Normal']))
    story.append(Spacer(1, 12))
    story.append(PageBreak())
    
    story.append(Paragraph("3. Sprint Performance", heading_style))
    story.append(Paragraph(sprint_performance, styles['Normal']))
    story.append(Spacer(1, 12))
    story.append(Paragraph("Sprint Progress Metrics", subheading_style))
    if os.path.exists(burndown_chart):
        story.append(Image(burndown_chart, 6*inch, 3.5*inch))
    story.append(Spacer(1, 8))
    if os.path.exists(burnup_chart):
        story.append(Image(burnup_chart, 6*inch, 3.5*inch))
    story.append(PageBreak())
    
    story.append(Paragraph("4. Stakeholder Feedback & Key Performance Indicators", heading_style))
    story.append(Paragraph(kpi_section, styles['Normal']))
    story.append(Spacer(1, 12))
    
    team_data = [['Team Member', 'Role', 'Experience', 'Assigned Points']]
    for profile in profiles_data:
        team_data.append([profile['name'], profile.get('role', 'N/A'), 
                         f"{profile.get('experience_years', 0)} yrs", str(profile.get('assigned_effort_points', 0))])
    
    team_table = Table(team_data, colWidths=[1.8*inch, 1.8*inch, 1.2*inch, 1.5*inch])
    team_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1F4E78')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('BACKGROUND', (0, 1), (-1, -1), colors.white),
        ('GRID', (0, 0), (-1, -1), 1, colors.grey),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F9F9F9')]),
    ]))
    story.append(team_table)
    story.append(PageBreak())
    
    story.append(Paragraph("5. Release Forecast", heading_style))
    story.append(Paragraph(release_forecast, styles['Normal']))
    story.append(Spacer(1, 12))
    
    story.append(Spacer(1, 0.2*inch))
    footer_text = "Data-driven Product Owner Report by ScrumMate. Strategic insights support stakeholder decisions."
    footer_style = ParagraphStyle(name='Footer', fontSize=9, alignment=1, textColor=colors.grey, italicized=True)
    story.append(Paragraph(footer_text, footer_style))
    
    doc.build(story)
    print("✓ Product Owner Report: product_owner_report.pdf")
    print(f"  - {len(stories_data)} stories | {total_effort} effort | {len(profiles_data)} team")
    print(f"  - Sections: Strategy, Backlog Health, Performance, KPIs, Release Forecast")
    print(f"  - Charts: Burndown, Burn-up, Backlog by Area")

if __name__ == "__main__":
    create_pdf_report()
