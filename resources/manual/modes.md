# Agent and Ask
Agent runs the available tool loop: it can inspect files, research, run commands or make approved changes. Actual tool availability and permission gates decide what it can do now.
Desktop Ask is a lightweight direct-answer request with tools=[] and no copied conversation history. Host help is injected locally before answering. Ask can explain a feature but cannot inspect the current screen, open settings, click, edit files or execute commands. Use Agent for observation or actions.
Desktop may automatically route short casual questions to lightweight Ask. Explicit operations, screen inspection, settings viewing and one-shot planning stay on Agent. A recent explicit help topic may be supplied as a tiny topic ID for an omitted-topic follow-up.
CLI chat/code/run use their own configured loops. A CLI side question (/btw) is tool-free; it is not desktop automation.
