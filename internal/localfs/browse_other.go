//go:build !darwin

package localfs

import "fmt"

func BrowseDirectory() (string, error) {
	return "", fmt.Errorf("browse directory is supported only on macOS desktop runtime")
}

func OpenDirectory(path string) error {
	return fmt.Errorf("open directory is supported only on macOS desktop runtime")
}

func OpenURL(target string) error {
	return fmt.Errorf("open url is supported only on macOS desktop runtime")
}
