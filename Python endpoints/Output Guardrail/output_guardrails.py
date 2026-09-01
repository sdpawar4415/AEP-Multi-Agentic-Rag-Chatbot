import re


# ==========================================
# Phone
# 9876123450
# -> 98******50
# ==========================================
def mask_phone(text):

    def repl(m):
        num = m.group(2)

        if len(num) <= 4:
            masked = "*" * len(num)
        else:
            masked = num[:2] + "*" * (len(num) - 4) + num[-2:]

        return f"{m.group(1)}: {masked}"

    # Normal format
    text = re.sub(
        r'(?im)^(Phone)\s*:\s*(\d+)$',
        repl,
        text
    )

    # Markdown format
    text = re.sub(
        r'(?im)^-\s*\*\*(Phone)\:\*\*\s*(\d+)$',
        repl,
        text
    )

    return text


# ==========================================
# Name
# Sayali Jadhav
# ->
# S***** J*****
# ==========================================
def mask_name_value(name):

    words = name.split()
    masked = []

    for w in words:
        if len(w) <= 1:
            masked.append(w)
        else:
            masked.append(w[0] + "*" * (len(w) - 1))

    return " ".join(masked)


def mask_names(text):

    def repl(m):
        label = m.group(1)
        value = m.group(2).strip()

        return f"{label}: {mask_name_value(value)}"

    def repl_markdown(m):
        label = m.group(1)
        value = m.group(2).strip()

        return f"- **{label}:** {mask_name_value(value)}"

    # Normal format
    pattern1 = (
        r'(?im)^(Customer|Customer Name|Name)\s*:\s*([^\n\r]+)$'
    )

    text = re.sub(pattern1, repl, text)

    # Markdown format
    pattern2 = (
        r'(?im)^-\s*\*\*(Customer|Customer Name|Name)\:\*\*\s*([^\n\r]+)$'
    )

    text = re.sub(pattern2, repl_markdown, text)

    return text


# ==========================================
# Address
# ==========================================
def mask_address_value(addr):

    def mask_word(word):

        if word.isdigit():

            if len(word) <= 2:
                return "*" * len(word)

            chars = []

            for i, c in enumerate(word):
                if i % 2 == 0:
                    chars.append(c)
                else:
                    chars.append("*")

            return "".join(chars)

        if word.lower() in ["unit", "floor", "suite"]:
            return word

        if len(word) <= 1:
            return word

        return word[0] + "*" * (len(word) - 1)

    parts = re.split(r'(\s+|,)', addr)

    return "".join(
        mask_word(p)
        if re.match(r'^[A-Za-z0-9]+$', p)
        else p
        for p in parts
    )


# ==========================================
# Address
# ==========================================
def mask_address(text):

    # ------------------------------------------
    # Plain inline
    # Address: 123 Main St
    # ------------------------------------------
    def repl(m):
        label = m.group(1)
        value = m.group(2).strip()
        return f"{label}: {mask_address_value(value)}"

    text = re.sub(
        r'(?im)^(Address)\s*:\s*(.+)$',
        repl,
        text
    )

    # ------------------------------------------
    # Markdown inline
    # - **Address:** 123 Main St
    # ------------------------------------------
    def repl_markdown_inline(m):
        label = m.group(1)
        value = m.group(2).strip()
        return f"- **{label}:** {mask_address_value(value)}"

    text = re.sub(
        r'(?im)^-\s*\*\*(Address)\:\*\*[ \t]*([^\n\r]+)$',
        repl_markdown_inline,
        text
    )

    # ------------------------------------------
    # Markdown multiline (INDENTED)
    #
    # - **Address:**
    #     123 Main St
    #     Houston, TX
    # ------------------------------------------
    pattern = (
        r'(?ims)'
        r'(^-\s*\*\*Address:\*\*[ \t]*\n)'
        r'((?:^[ \t]+.*(?:\n|$))+)'
    )

    def repl_markdown(m):
        header = m.group(1)
        block = m.group(2)

        lines = block.splitlines()

        if lines:
            lines[0] = mask_address_value(lines[0].strip())

        return header + "\n".join(lines)

    text = re.sub(pattern, repl_markdown, text)

    # ------------------------------------------
    # Markdown multiline (NO INDENTATION)
    #
    # - **Address:**
    # 123 Main St
    # Houston, TX
    # USA
    # ------------------------------------------
    pattern = (
        r'(?im)'
        r'(^-\s*\*\*Address:\*\*[ \t]*\n)'
        r'([^\n\r]+)'
    )

    def repl_markdown_no_indent(m):
        header = m.group(1)
        first_line = m.group(2).strip()

        return header + mask_address_value(first_line)

    text = re.sub(pattern, repl_markdown_no_indent, text)

    # ------------------------------------------
    # Plain multiline
    #
    # Address:
    # 123 Main St
    # Houston, TX
    # ------------------------------------------
    pattern = (
        r'(?im)'
        r'^(Address)\s*:\s*\n'
        r'([^\n\r]+)'
    )

    def repl_plain_multiline(m):
        label = m.group(1)
        first_line = m.group(2).strip()

        return f"{label}:\n{mask_address_value(first_line)}"

    text = re.sub(pattern, repl_plain_multiline, text)

    return text
# ==========================================
# Master
# ==========================================
def mask_pii(text):

    # Replace unicode narrow spaces
    text = text.replace("\u202f", " ")
    text = text.replace("\u2009", " ")

    text = mask_phone(text)
    text = mask_names(text)
    text = mask_address(text)

    return text