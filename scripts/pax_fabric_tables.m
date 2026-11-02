let
    Endpoint = #"Fabric SQL Endpoint",
    Database = #"Fabric Lakehouse",
    Schema = #"PAX SQL Schema",
    Source = if not Value.Is(Endpoint, type text) or not Value.Is(Database, type text) or not Value.Is(Schema, type text)
            then error "Enter the Fabric SQL endpoint, database and SQL schema."
        else if Endpoint = "" or Database = "" or Schema = "" or Endpoint <> Text.Trim(Endpoint)
            or Database <> Text.Trim(Database) or Schema <> Text.Trim(Schema) or Text.Contains(Endpoint, "://")
            then error "Use the SQL endpoint hostname, database and schema unchanged, without URLs or surrounding whitespace."
        else Sql.Database(#"Fabric SQL Endpoint", #"Fabric Lakehouse", [CreateNavigationProperties=false]),
    Connection = Source
in
    Connection
