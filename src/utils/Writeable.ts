
type Writeable<T extends { [x: string]: any }> = {
    [P in keyof T]: T[P];
}