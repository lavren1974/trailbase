SELECT
{% for name in column_names -%}
  {%- if !loop.first %},{% endif %}MAIN."{{ name }}"
{%- endfor %}
FROM "{{ table_name }}" as MAIN WHERE MAIN."{{ pk_column_name }}" = ?1
