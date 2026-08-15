
def check_css_balance(filepath):
    with open(filepath, 'r') as f:
        lines = f.readlines()
    
    open_braces = 0
    errors = []
    
    for i, line in enumerate(lines):
        # Remove comments roughly (not perfect but good enough for simple check)
        clean_line = line.split('/*')[0].split('//')[0] 
        # Note: CSS doesn't use // comments but let's be safe. standard is /* */
        # Better: remove all /* ... */ matches
        
        open_braces += line.count('{')
        open_braces -= line.count('}')
        
        if open_braces < 0:
            errors.append(f"Line {i+1}: Unexpected closing brace. Balance: {open_braces}")
            open_braces = 0 # Reset to continue finding errors
            
    if open_braces > 0:
        errors.append(f"End of file: Missing {open_braces} closing braces.")
        
    if not errors:
        print("CSS seems balanced.")
    else:
        print("Found errors:")
        for e in errors:
            print(e)
        # Print last few lines if missing brace
        if "End of file" in errors[-1]:
            print("\nLast 10 lines:")
            print("".join(lines[-10:]))

check_css_balance('themes/ortez-theme/assets/css/style.css')
