import json
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from datetime import datetime
from reportlab.lib.pagesizes import letter, A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak
from reportlab.lib import colors
from reportlab.lib.units import inch
import os
import sys
from pathlib import Path

# Add scrummate_agentic to path for imports
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE_DIR, 'scrummate_agentic'))

# Import AI client
try:
    from services.gemini_client import GeminiClient
    AI_AVAILABLE = True
except ImportError:
    AI_AVAILABLE = False
    print("Warning: Gemini client not available. Using static content.")

# Paths
STORIES_PATH = os.path.join(BASE_DIR, 'userstory', 'stories.json')
PROFILES_PATH = os.path.join(BASE_DIR, 'scrummate_agentic', 'sprintmembers', 'profile.json')
MOM_PATH = os.path.join(BASE_DIR, 'scrummate_agentic', 'prompts', 'po_meeting', 'final_minutes.txt')

def load_json(path):
    """Load JSON from file"""
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading {path}: {e}")
        return []

def load_text(path):
    """Load text file"""
    try:
        with open(path, 'r') as f:
            return f.read()
    except Exception as e:
        print(f"Error loading {path}: {e}")
        return "No MOM available"

def generate_ai_prompt(prompt_text, stories_data, profiles_data):
    """Generate content using AI prompts"""
    if not AI_AVAILABLE:
        return "AI-generated content unavailable. Using fallback."
    
    try:
        client = GeminiClient()
        return client.generate(prompt_text, max_tokens=1500)
    except Exception as e:
        print(f"AI generation error: {e}")
        return "Unable to generate AI content."

def generate_product_strategy_section(stories_data, profiles_data):
    """Generate Product Strategy & Roadmap Updates using AI"""
    high_urgency = sum(1 for s in stories_data if s.get('urgency') == 'High')
    medium_urgency = sum(1 for s in stories_data if s.get('urgency') == 'Medium')
    total_effort = sum(s['effort_points'] for s in stories_data)
    
    prompt = f"""
    Based on the following ScrumMate project details, generate a concise Product Strategy & Roadmap Updates section (150-200 words):
    
    Project Context:
    - Total User Stories: {len(stories_data)}
    - High Priority Stories: {high_urgency}
    - Medium Priority Stories: {medium_urgency}
    - Total Effort Points: {total_effort}
    - Team Size: {len(profiles_data)} members
    
    Sample Stories:
    {json.dumps(stories_data[:5], indent=2)}
    
    Generate insights about:
    1. Strategic goals and direction
    2. Key features planned for upcoming sprints
    3. Product value proposition
    4. Changes in strategic priorities
    
    Keep it professional and actionable for stakeholders.
    """
    return generate_ai_prompt(prompt, stories_data, profiles_data)

def generate_backlog_health_section(stories_data):
    """Generate Product Backlog Health section using AI"""
    skills_needed = set()
    for s in stories_data:
        skills_needed.add(s.get('skill_required', 'General'))
    
    prompt = f"""
    Generate a Product Backlog Health assessment (150-200 words) based on:
    
    Backlog Metrics:
    - Total Stories: {len(stories_data)}
    - Skills Required: {', '.join(sorted(skills_needed))}
    - Story Distribution: {{'High': {sum(1 for s in stories_data if s.get('urgency') == 'High')}, 'Medium': {sum(1 for s in stories_data if s.get('urgency') == 'Medium')}, 'Low': {sum(1 for s in stories_data if s.get('urgency') == 'Low')}}}
    - Avg Effort Points: {sum(s['effort_points'] for s in stories_data) / len(stories_data) if stories_data else 0:.1f}
    
    Sample Backlog Items:
    {json.dumps([{'id': s['id'], 'urgency': s.get('urgency'), 'effort': s.get('effort_points')} for s in stories_data[:8]], indent=2)}
    
    Address:
    1. Backlog grooming status
    2. Prioritization alignment
    3. Story readiness for upcoming sprints
    4. Any grooming recommendations
    
    Keep it concise and actionable.
    """
    return generate_ai_prompt(prompt, stories_data, [])

def generate_sprint_performance_section(stories_data, profiles_data):
    """Generate Sprint Performance section using AI"""
    assigned_effort = sum(p['assigned_effort_points'] for p in profiles_data)
    total_effort = sum(s['effort_points'] for s in stories_data)
    completion_rate = (assigned_effort / total_effort * 100) if total_effort > 0 else 0
    
    prompt = f"""
    Generate a Sprint Performance review (150-200 words) based on:
    
    Sprint Metrics:
    - Current Velocity: {assigned_effort} story points assigned
    - Sprint Goal: {total_effort} story points planned
    - Progress: {completion_rate:.1f}% of work assigned
    - Team Capacity: {len(profiles_data)} members
    - Average Team Load: {assigned_effort / len(profiles_data):.1f} points per member
    
    Team Performance:
    {json.dumps([{'name': p['name'], 'role': p['role'], 'effort': p['assigned_effort_points']} for p in profiles_data], indent=2)}
    
    Analyze:
    1. Sprint velocity trends
    2. Scope creep assessment
    3. Delivered value vs. expectations
    4. Workload balance
    5. Any blockers or risks
    
    Be specific and data-driven.
    """
    return generate_ai_prompt(prompt, stories_data, profiles_data)

def generate_kpi_section(stories_data, profiles_data, meetings_count=0):
    """Generate KPIs & Metrics section using AI"""
    prompt = f"""
    Generate a Stakeholder Feedback & Key Performance Indicators section (150-200 words) for ScrumMate:
    
    Current Project Metrics:
    - Total User Stories: {len(stories_data)}
    - Total Sprint Capacity: {sum(s['effort_points'] for s in stories_data)} points
    - Team Size: {len(profiles_data)} developers
    - Meetings Conducted: {meetings_count}
    
    Quality Indicators:
    - Stories with Clear Acceptance Criteria: {sum(1 for s in stories_data if s.get('acceptance_criteria'))} / {len(stories_data)}
    - High Priority Stories: {sum(1 for s in stories_data if s.get('urgency') == 'High')}
    
    Team Expertise:
    - Average Team Experience: {sum(p.get('experience_years', 0) for p in profiles_data) / len(profiles_data) if profiles_data else 0:.1f} years
    - Technical Coverage: {len(set(s.get('skill_required', '') for s in stories_data))} different skill areas
    
    Discuss:
    1. Product quality metrics
    2. Customer satisfaction indicators
    3. Team productivity metrics
    4. Market-relevant KPIs
    5. Risk indicators
    
    Focus on actionable insights.
    """
    return generate_ai_prompt(prompt, stories_data, profiles_data)

def generate_release_forecast_section(stories_data):
    """Generate Release Forecast section using AI"""
    total_effort = sum(s['effort_points'] for s in stories_data)
    avg_velocity = total_effort / 10  # Assuming 10-day sprints
    
    prompt = f"""
    Generate a Release Forecast (150-200 words) based on:
    
    Release Planning Data:
    - Total Work Remaining: {total_effort} story points
    - Estimated Velocity: {avg_velocity:.1f} points per sprint
    - Estimated Sprints to Completion: {total_effort / avg_velocity if avg_velocity > 0 else 0:.1f}
    - Current Team Capacity: 5 members
    
    High Priority Items ({sum(1 for s in stories_data if s.get('urgency') == 'High')}):
    {json.dumps([s['id'] for s in stories_data if s.get('urgency') == 'High'][:5], indent=2)}
    
    Provide:
    1. Timeline estimates for feature releases
    2. Critical path dependencies
    3. Risk-based release scenarios (best case, expected, worst case)
    4. Resource allocation recommendations
    5. Go-to-market considerations
    
    Be realistic and data-backed.
    """
    return generate_ai_prompt(prompt, stories_data, [])

def generate_burndown_chart(stories, profiles):
    """Generate burndown chart based on project data"""
    # Calculate total effort points
    total_effort = sum(s['effort_points'] for s in stories)
    
    # Calculate completed effort (based on assigned members, assuming 50% done)
    completed_effort = sum(p['assigned_effort_points'] for p in profiles) // 2
    
    # Generate sprint timeline
    sprint_days = 10
    days = list(range(1, sprint_days + 1))
    
    # Ideal burndown (linear from total to 0)
    ideal = [total_effort - (total_effort / sprint_days) * i for i in days]
    
    # Actual burndown (simulated with some variance)
    actual = []
    remaining = total_effort
    for i in range(len(days)):
        if i < len(days) - 1:
            decrease = (total_effort / sprint_days) * 0.85 + (i * 0.5)  # Slight variance
            remaining = max(0, remaining - decrease)
        actual.append(remaining)
    
    # Create figure with better styling
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.plot(days, ideal, marker='o', label='Ideal Burndown', linestyle='--', linewidth=2, color='#2E86AB')
    ax.plot(days, actual, marker='s', label='Actual Burndown', linewidth=2, color='#A23B72')
    
    ax.set_xlabel('Sprint Days', fontsize=12, fontweight='bold')
    ax.set_ylabel('Remaining Effort Points', fontsize=12, fontweight='bold')
    ax.set_title('Sprint Burndown Chart', fontsize=14, fontweight='bold')
    ax.legend(fontsize=10)
    ax.grid(True, alpha=0.3)
    ax.set_xticks(days)
    
    # Fill area under the curve
    ax.fill_between(days, ideal, alpha=0.1, color='#2E86AB')
    ax.fill_between(days, actual, alpha=0.1, color='#A23B72')
    
    chart_path = os.path.join(BASE_DIR, 'burndown_chart.png')
    plt.tight_layout()
    plt.savefig(chart_path, dpi=300, bbox_inches='tight')
    plt.close()
    return chart_path

def generate_effort_distribution_chart(profiles):
    """Generate effort distribution pie chart"""
    names = [p['name'].split()[0] for p in profiles]  # First name only
    efforts = [p['assigned_effort_points'] for p in profiles]
    
    fig, ax = plt.subplots(figsize=(8, 6))
    colors_pie = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8']
    wedges, texts, autotexts = ax.pie(efforts, labels=names, autopct='%1.1f%%', 
                                        colors=colors_pie[:len(profiles)], startangle=90)
    
    for autotext in autotexts:
        autotext.set_color('white')
        autotext.set_fontweight('bold')
    
    ax.set_title('Effort Points Distribution by Team Member', fontsize=14, fontweight='bold')
    
    chart_path = os.path.join(BASE_DIR, 'effort_distribution.png')
    plt.tight_layout()
    plt.savefig(chart_path, dpi=300, bbox_inches='tight')
    plt.close()
    return chart_path

def generate_story_complexity_chart(stories):
    """Generate story complexity distribution chart"""
    urgencies = {}
    for story in stories:
        urgency = story.get('urgency', 'Medium')
        urgencies[urgency] = urgencies.get(urgency, 0) + 1
    
    fig, ax = plt.subplots(figsize=(8, 5))
    bars = ax.bar(urgencies.keys(), urgencies.values(), color=['#E74C3C', '#F39C12', '#27AE60'])
    ax.set_ylabel('Number of Stories', fontsize=11, fontweight='bold')
    ax.set_xlabel('Urgency Level', fontsize=11, fontweight='bold')
    ax.set_title('User Stories by Urgency', fontsize=14, fontweight='bold')
    
    # Add value labels on bars
    for bar in bars:
        height = bar.get_height()
        ax.text(bar.get_x() + bar.get_width()/2., height,
                f'{int(height)}', ha='center', va='bottom', fontweight='bold')
    
    chart_path = os.path.join(BASE_DIR, 'story_complexity.png')
    plt.tight_layout()
    plt.savefig(chart_path, dpi=300, bbox_inches='tight')
    plt.close()
    return chart_path

def create_pdf_report():
    """Create comprehensive Product Owner Report PDF"""
    doc = SimpleDocTemplate(os.path.join(BASE_DIR, "product_owner_report.pdf"), pagesize=letter)
    styles = getSampleStyleSheet()
    story = []
    
    # Custom styles
    title_style = ParagraphStyle(
        name='CustomTitle',
        fontSize=24,
        alignment=1,
        spaceAfter=6,
        textColor=colors.HexColor('#1F4E78'),
        fontName='Helvetica-Bold'
    )
    
    heading_style = ParagraphStyle(
        name='CustomHeading',
        fontSize=14,
        alignment=0,
        spaceAfter=12,
        textColor=colors.HexColor('#2E75B5'),
        fontName='Helvetica-Bold',
        spaceBefore=12
    )
    
    # Load data
    stories_data = load_json(STORIES_PATH)
    profiles_data = load_json(PROFILES_PATH)
    mom_text = load_text(MOM_PATH)
    meetings_data = get_meeting_summaries()
    project_overview = get_project_overview(stories_data, profiles_data)
    
    # ========== PAGE 1: COVER AND SUMMARY ==========
    story.append(Spacer(1, 0.5*inch))
    story.append(Paragraph("PRODUCT OWNER SUMMARY REPORT", title_style))
    story.append(Spacer(1, 6))
    
    # Report metadata
    metadata_style = ParagraphStyle(name='Meta', fontSize=10, alignment=1, textColor=colors.grey)
    story.append(Paragraph(f"Generated on: {datetime.now().strftime('%B %d, %Y')}", metadata_style))
    story.append(Paragraph(f"Project: ScrumMate", metadata_style))
    story.append(Spacer(1, 0.3*inch))
    
    # Executive Summary
    story.append(Paragraph("Executive Summary", heading_style))
    summary_text = f"""
    This comprehensive report provides an overview of the current sprint progress, including key metrics, 
    team assignments, task status, and burndown analysis. The report encompasses {len(stories_data)} user stories 
    with a combined effort of {sum(s['effort_points'] for s in stories_data)} story points assigned to {len(profiles_data)} team members.
    """
    story.append(Paragraph(summary_text, styles['Normal']))
    story.append(Spacer(1, 12))
    
    # ========== PROJECT OVERVIEW SECTION ==========
    story.append(Paragraph("Project Overview", heading_style))
    story.append(Spacer(1, 6))
    
    overview_text = f"""
    <b>Project Name:</b> ScrumMate<br/>
    <b>Sprint Status:</b> In Progress<br/>
    <b>Team Size:</b> {project_overview['team_size']} members<br/>
    <b>Total User Stories:</b> {project_overview['total_stories']}<br/>
    <b>Total Effort Points:</b> {project_overview['total_effort']} story points<br/>
    <b>Average Effort per Story:</b> {project_overview['avg_effort_per_story']} points<br/>
    <b>Skills Required:</b> {project_overview['skills_needed']}<br/>
    <br/>
    <b>Story Breakdown by Urgency:</b><br/>
    • High Urgency: {project_overview['high_urgency']} stories<br/>
    • Medium Urgency: {project_overview['medium_urgency']} stories<br/>
    • Low Urgency: {project_overview['low_urgency']} stories
    """
    story.append(Paragraph(overview_text, styles['Normal']))
    story.append(Spacer(1, 12))
    
    # ========== MEETINGS SUMMARY SECTION ==========
    if meetings_data:
        story.append(Paragraph("Meeting Summary", heading_style))
        story.append(Spacer(1, 6))
        
        meetings_info = [['Date', 'Duration (sec)', 'Speakers', 'Total Words']]
        for meeting in meetings_data[:5]:  # Show last 5 meetings
            date_str = meeting['date'].split('T')[0] if 'T' in meeting['date'] else meeting['date']
            meetings_info.append([
                date_str,
                str(meeting['duration']),
                str(meeting['speakers']),
                str(meeting['words'])
            ])
        
        meetings_table = Table(meetings_info, colWidths=[1.5*inch, 1.5*inch, 1.5*inch, 1.5*inch])
        meetings_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1F4E78')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, 0), 10),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 10),
            ('BACKGROUND', (0, 1), (-1, -1), colors.white),
            ('GRID', (0, 0), (-1, -1), 1, colors.grey),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F9F9F9')]),
        ]))
        story.append(meetings_table)
        story.append(Spacer(1, 6))
        
        meeting_summary = f"<b>Total Meetings Recorded:</b> {len(meetings_data)}<br/>"
        if meetings_data:
            avg_duration = sum(m['duration'] for m in meetings_data) / len(meetings_data)
            total_words = sum(m['words'] for m in meetings_data)
            meeting_summary += f"<b>Average Meeting Duration:</b> {avg_duration:.0f} seconds<br/>"
            meeting_summary += f"<b>Total Words Transcribed:</b> {total_words}<br/>"
        
        story.append(Paragraph(meeting_summary, styles['Normal']))
        story.append(Spacer(1, 12))
    
    # Key Metrics Summary
    story.append(Paragraph("Key Metrics", heading_style))
    total_effort = sum(s['effort_points'] for s in stories_data)
    assigned_effort = sum(p['assigned_effort_points'] for p in profiles_data)
    completion_rate = (assigned_effort / total_effort * 100) if total_effort > 0 else 0
    
    metrics_data = [
        ['Metric', 'Value', 'Status'],
        ['Total User Stories', len(stories_data), '✓'],
        ['Total Effort Points', total_effort, '✓'],
        ['Assigned Effort Points', assigned_effort, '✓'],
        ['Team Members', len(profiles_data), '✓'],
        ['Estimated Completion Rate', f'{completion_rate:.1f}%', '→'],
    ]
    
    metrics_table = Table(metrics_data, colWidths=[2.5*inch, 1.5*inch, 0.8*inch])
    metrics_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1F4E78')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 11),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
        ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#D9E8F5')),
        ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#1F4E78')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F0F0F0')]),
        ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 1), (-1, -1), 10),
    ]))
    story.append(metrics_table)
    story.append(PageBreak())
    
    # ========== PAGE 2: BURNDOWN AND ANALYTICS ==========
    story.append(Paragraph("Sprint Progress & Analytics", heading_style))
    story.append(Spacer(1, 6))
    
    # Burndown Chart
    story.append(Paragraph("Sprint Burndown Chart", styles['Heading3']))
    chart_path = generate_burndown_chart(stories_data, profiles_data)
    if os.path.exists(chart_path):
        story.append(Image(chart_path, 6.5*inch, 4*inch))
    story.append(Spacer(1, 12))
    
    # Effort Distribution
    story.append(Paragraph("Team Effort Distribution", styles['Heading3']))
    effort_chart = generate_effort_distribution_chart(profiles_data)
    if os.path.exists(effort_chart):
        story.append(Image(effort_chart, 5*inch, 4*inch))
    story.append(PageBreak())
    
    # ========== PAGE 3: TEAM ASSIGNMENTS ==========
    story.append(Paragraph("Team Member Assignments", heading_style))
    story.append(Spacer(1, 6))
    
    assignment_data = [['Name', 'Role', 'Skills', 'Effort Points']]
    for profile in profiles_data:
        skills_str = ', '.join(profile.get('skills', [])[:3]) + '...'  # First 3 skills
        assignment_data.append([
            profile['name'],
            profile.get('role', 'N/A'),
            skills_str,
            str(profile.get('assigned_effort_points', 0))
        ])
    
    assignment_table = Table(assignment_data, colWidths=[1.5*inch, 1.5*inch, 2.5*inch, 1*inch])
    assignment_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1F4E78')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 10),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 10),
        ('BACKGROUND', (0, 1), (-1, -1), colors.white),
        ('GRID', (0, 0), (-1, -1), 1, colors.grey),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F9F9F9')]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    story.append(assignment_table)
    story.append(Spacer(1, 12))
    
    # Story Complexity
    story.append(Paragraph("User Stories by Urgency", styles['Heading3']))
    complexity_chart = generate_story_complexity_chart(stories_data)
    if os.path.exists(complexity_chart):
        story.append(Image(complexity_chart, 5.5*inch, 3.5*inch))
    story.append(PageBreak())
    
    # ========== PAGE 4: USER STORIES ==========
    story.append(Paragraph("User Stories Overview", heading_style))
    story.append(Spacer(1, 6))
    
    story_count = 0
    for us in stories_data[:10]:  # Show first 10 stories
        story_count += 1
        story.append(Paragraph(f"<b>{us['id']} - {us['user_story'][:80]}...</b>", styles['Normal']))
        
        story_details = [
            ['Effort Points', 'Urgency', 'Skill Required'],
            [str(us.get('effort_points', 0)), us.get('urgency', 'Medium'), us.get('skill_required', 'N/A')]
        ]
        
        story_table = Table(story_details, colWidths=[1.5*inch, 1.5*inch, 2.5*inch])
        story_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E7E6E6')),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('GRID', (0, 0), (-1, -1), 1, colors.lightgrey),
            ('BACKGROUND', (0, 1), (-1, 1), colors.HexColor('#F5F5F5')),
        ]))
        story.append(story_table)
        story.append(Spacer(1, 8))
    
    if len(stories_data) > 10:
        story.append(Paragraph(f"... and {len(stories_data) - 10} more user stories", styles['Normal']))
    
    story.append(PageBreak())
    
    # ========== PAGE 5: MINUTES OF MEETING ==========
    story.append(Paragraph("Minutes of Meeting (MOM)", heading_style))
    story.append(Spacer(1, 6))
    
    mom_content = mom_text[:2000]  # Limit to first 2000 chars to fit on page
    if len(mom_text) > 2000:
        mom_content += f"\n\n[... Full MOM available in project records ...]"
    
    story.append(Paragraph(mom_content.replace('\n', '<br/>'), styles['Normal']))
    story.append(Spacer(1, 12))
    
    # Footer
    story.append(Spacer(1, 0.2*inch))
    footer_text = "This is an automated report generated by ScrumMate. For detailed analysis, please refer to the project dashboard."
    footer_style = ParagraphStyle(name='Footer', fontSize=9, alignment=1, textColor=colors.grey, italicized=True)
    story.append(Paragraph(footer_text, footer_style))
    
    # Build PDF
    doc.build(story)
    print("✓ Comprehensive PDF report generated: product_owner_report.pdf")
    print(f"  - {len(stories_data)} user stories analyzed")
    print(f"  - {len(profiles_data)} team members profiled")
    print(f"  - Total effort: {total_effort} story points")
    print(f"  - Charts generated: Burndown, Effort Distribution, Story Complexity")

if __name__ == "__main__":
    create_pdf_report()